"""Recorded settings are checked before an expired coordinator changes state."""

from __future__ import annotations

import datetime
import json
import sqlite3
import uuid
from pathlib import Path

import pytest
from workbench_test_support import run_workbench


def database_snapshot(state: Path) -> str:
    with sqlite3.connect(state / "workbench.sqlite3") as connection:
        return "\n".join(connection.iterdump())


@pytest.mark.parametrize("version", ["deep-security-scan/v1", "deep-scan-mcp/v1"])
@pytest.mark.parametrize("saved", ["unsupported", "missing-home", "valid", "absent"])
@pytest.mark.parametrize("live", [False, True], ids=["expired-owner", "live-observer"])
def test_reader_checks_recorded_settings_before_adoption(
    tmp_path: Path, version: str, saved: str, live: bool
) -> None:
    state, target = tmp_path / "state", tmp_path / "target"
    target.mkdir()
    run = run_workbench(
        state,
        "begin-deep-scan",
        "--thread-id",
        "original-thread",
        "--target-path",
        str(target),
        "--scan-root",
        str(tmp_path / "scans"),
        "--workflow-version",
        version,
    )["deepScan"]
    scan_dir = Path(run["scanDir"])
    worker_dir = scan_dir / "artifacts" / "deep_discovery" / "worker"
    worker_dir.mkdir(parents=True)
    prompt = worker_dir / "prompt.md"
    prompt.write_text("Original discovery input")
    run_workbench(
        state,
        "upsert-deep-scan-worker",
        "--scan-id",
        run["scanId"],
        "--worker-id",
        str(uuid.uuid4()),
        "--kind",
        "discovery",
        "--status",
        "running",
        "--prompt-path",
        str(prompt),
        "--artifact-dir",
        str(worker_dir),
        "--attempt",
        "1",
    )
    path = worker_dir.parent / "execution-settings.json"
    if saved != "absent":
        settings = {"codexPath": "/fixture/codex", "codexHome": "/fixture/original-home"}
        if saved == "missing-home":
            del settings["codexHome"]
        path.write_text(
            json.dumps({"version": 99 if saved == "unsupported" else 1, "settings": settings})
        )
    with sqlite3.connect(state / "workbench.sqlite3") as connection:
        connection.execute(
            "UPDATE deep_scan_runs SET coordinator_generation = 2, updated_at = ?",
            (
                datetime.datetime.now(datetime.timezone.utc).isoformat()
                if live
                else "2000-01-01T00:00:00Z",
            ),
        )
    before = database_snapshot(state)
    files = {
        item.relative_to(scan_dir): item.read_bytes()
        for item in scan_dir.rglob("*")
        if item.is_file()
    }
    rejects = not live and saved in {"unsupported", "missing-home"}
    result = run_workbench(
        state,
        "claim-deep-scan-coordinator",
        "--scan-id",
        run["scanId"],
        "--thread-id",
        "original-thread",
        check=not rejects,
    )
    if rejects:
        assert result["returncode"] != 0
        assert "settings" in result["stderr"].lower()
        assert database_snapshot(state) == before
    else:
        observed = result
        assert observed["coordinatorDisposition"] == ("observing" if live else "adopted")
        assert observed["deepScan"]["workflowVersion"] == version
        if live:
            assert database_snapshot(state) == before
    assert {
        item.relative_to(scan_dir): item.read_bytes()
        for item in scan_dir.rglob("*")
        if item.is_file()
    } == files
