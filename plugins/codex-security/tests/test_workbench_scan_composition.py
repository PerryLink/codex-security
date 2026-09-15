from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from workbench_test_support import run_workbench, write_checkpoint, write_completed_contract

CHECKPOINT = "artifacts/deep-scan/checkpoint.json"


def recipe(target: Path, mode: str = "standard") -> dict:
    return {
        "repository": str(target),
        "target": {"kind": "repository", "paths": []},
        "mode": mode,
        "config": {"model": "synthetic-model", "model_reasoning_effort": "high"},
        **({"deepScan": {"maxDiscoveryRuns": 8}} if mode == "deep" else {}),
    }


def register(state: Path, target: Path, directory: Path, *, mode="standard", parent=None) -> dict:
    missing = []
    current = directory
    while not current.exists():
        missing.append(current)
        current = current.parent
    for path in reversed(missing):
        path.mkdir(mode=0o700)
    return run_workbench(
        state,
        "register-cli-scan",
        "--repository",
        str(target),
        "--scan-dir",
        str(directory),
        "--recipe-json",
        json.dumps(recipe(target, mode)),
        *(("--parent-scan-id", parent) if parent else ()),
    )


def checkpoint(state: Path, scan: dict, *, passes=(), merged=(), terminal=None) -> dict:
    value = {
        "version": 2,
        "startedAt": "2026-01-01T00:00:00Z",
        "passes": list(passes),
        "mergedScanIds": list(merged),
        "aggregate": [],
        "noNewStreak": 0,
        "consecutiveErrors": 0,
        **({"terminalReason": terminal} if terminal else {}),
    }
    run_workbench(
        state,
        "save-scan-artifact",
        "--scan-id",
        scan["scanId"],
        "--artifact-path",
        CHECKPOINT,
        input_text=json.dumps(value),
    )
    return value


def test_standard_resume_retains_registration_before_and_after_thread_binding(
    tmp_path: Path,
) -> None:
    target = tmp_path / "target"
    target.mkdir()
    (target / "app.py").write_text("print('fixture')\n")
    state = tmp_path / "state"
    scan = register(state, target, tmp_path / "scan")
    resume = run_workbench(state, "get-cli-scan-resume", "--scan-id", scan["scanId"])
    assert resume["scanId"] == scan["scanId"]
    assert resume["threadId"] is None
    assert resume["recipe"] == recipe(target)
    run_workbench(state, "set-scan-thread", "--scan-id", scan["scanId"], "--thread-id", "execution")
    resume = run_workbench(state, "get-cli-scan-resume", "--scan-id", scan["scanId"])
    assert resume["threadId"] == "execution"
    assert len(run_workbench(state, "list-scans")["scans"]) == 1
    (target / "app.py").write_text("print('changed')\n")
    rejected = run_workbench(state, "get-cli-scan-resume", "--scan-id", scan["scanId"], check=False)
    assert "original checkout revision or contents changed" in rejected["stderr"]


def test_native_parent_binds_once_and_keeps_native_claim(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    (target / "app.py").write_text("print('fixture')\n")
    state = tmp_path / "state"
    arguments = (
        "begin-deep-scan",
        "--thread-id",
        "native-owner",
        "--target-path",
        str(target),
        "--scope",
        ".",
        "--scan-root",
        str(tmp_path / "scans"),
    )
    created = run_workbench(state, *arguments)
    scan = created["scan"]
    assert run_workbench(state, *arguments)["scan"]["scanId"] == scan["scanId"]
    token = scan["handoffClaimToken"]
    registration = {
        "recipe": recipe(target, "deep"),
        "scanId": scan["scanId"],
        "threadId": "native-owner",
        "claimToken": token,
    }
    bind = (
        "register-cli-scan",
        "--repository",
        str(target),
        "--scan-dir",
        scan["scanDir"],
        "--registration-json-stdin",
    )
    rejected = run_workbench(
        state,
        *bind,
        input_text=json.dumps({**registration, "claimToken": None}),
        check=False,
    )
    assert "owned by another continuation" in rejected["stderr"]
    first = run_workbench(state, *bind, input_text=json.dumps(registration))
    assert first["threadId"] is None
    assert first["claimToken"] == token
    assert run_workbench(state, *bind, input_text=json.dumps(registration))["threadId"] is None
    assert run_workbench(state, *arguments)["scan"]["scanId"] == scan["scanId"]
    rejected = run_workbench(
        state,
        "set-scan-thread",
        "--scan-id",
        scan["scanId"],
        "--thread-id",
        "sdk-execution",
        check=False,
    )
    assert rejected["returncode"] != 0
    run_workbench(
        state,
        "set-scan-thread",
        "--scan-id",
        scan["scanId"],
        "--thread-id",
        "sdk-execution",
        "--claim-token",
        token,
    )
    rebound = run_workbench(state, *bind, input_text=json.dumps(registration))
    assert rebound["threadId"] == "sdk-execution"
    resumed = run_workbench(
        state,
        "get-cli-scan-resume",
        "--scan-id",
        scan["scanId"],
        "--claim-token",
        token,
    )
    assert resumed["threadId"] == "sdk-execution"
    assert len(run_workbench(state, "list-scans")["scans"]) == 1
    with sqlite3.connect(state / "workbench.sqlite3") as connection:
        assert connection.execute("SELECT COUNT(*) FROM deep_scan_runs").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM deep_scan_workers").fetchone()[0] == 0
    rejected = run_workbench(
        state,
        "cancel-scan",
        "--scan-id",
        scan["scanId"],
        "--thread-id",
        "other-owner",
        check=False,
    )
    assert rejected["returncode"] != 0
    run_workbench(state, "cancel-scan", "--scan-id", scan["scanId"], "--thread-id", "native-owner")
    assert (
        run_workbench(state, "get-scan", "--scan-id", scan["scanId"])["scan"]["progress"]["status"]
        == "canceled"
    )

    joined = run_workbench(
        state,
        "begin-deep-scan",
        "--scan-id",
        scan["scanId"],
        "--thread-id",
        "native-owner",
        "--claim-token",
        token,
    )
    assert joined["startDisposition"] == "joined"
    assert joined["scan"]["progress"]["status"] == "canceled"
    rejected = run_workbench(
        state,
        "get-cli-scan-resume",
        "--scan-id",
        scan["scanId"],
        "--claim-token",
        token,
        check=False,
    )
    assert rejected["returncode"] != 0


def test_parent_reads_completed_child_after_registration_checkpoint_crash(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    (target / "app.py").write_text("print('fixture')\n")
    state = tmp_path / "state"
    parent = register(state, target, tmp_path / "scan", mode="deep")
    directory = Path(parent["scanDir"]) / "artifacts/deep-scan/passes/pass-1"
    saved = checkpoint(state, parent, passes=[{"directory": str(directory)}])
    child = register(state, target, directory, parent=parent["scanId"])
    run_workbench(
        state, "set-scan-thread", "--scan-id", child["scanId"], "--thread-id", "child-thread"
    )
    unrelated = register(state, target, tmp_path / "rerun", parent=parent["scanId"])
    run_workbench(
        state, "set-scan-thread", "--scan-id", unrelated["scanId"], "--thread-id", "rerun-thread"
    )
    write_completed_contract(directory, child["scanId"], target, relative_path="app.py")
    run_workbench(state, "complete-scan", "--scan-id", child["scanId"])
    child_bytes = (directory / "scan-manifest.json").read_bytes()
    visible = run_workbench(state, "list-scans")["scans"]
    assert {item["scanId"] for item in visible} == {parent["scanId"], unrelated["scanId"]}
    assert run_workbench(state, "list-global-findings")["findings"] == []
    assert (
        run_workbench(state, "get-scan", "--scan-id", child["scanId"])["scan"]["findingCount"] == 1
    )
    context = run_workbench(state, "get-scan", "--scan-id", parent["scanId"])
    assert context["compositionCheckpoint"] == saved
    assert context["scan"]["executionThreadIds"] == ["child-thread"]
    assert context["scan"]["progress"]["independentReviews"] == {
        "active": 0,
        "completed": 1,
        "maximum": 8,
        "consolidating": True,
    }
    recovered = run_workbench(state, "list-scans", "--scan-root", str(directory))["scans"]
    assert [item["scanId"] for item in recovered] == [child["scanId"]]
    assert recovered[0]["parentScanId"] == parent["scanId"]
    write_completed_contract(
        Path(parent["scanDir"]),
        parent["scanId"],
        target,
        relative_path="app.py",
        coverage_mode="deep_repository",
    )
    blocked = run_workbench(state, "complete-scan", "--scan-id", parent["scanId"], check=False)
    assert "must finish and save its aggregate" in blocked["stderr"]
    checkpoint(
        state, parent, passes=saved["passes"], merged=[child["scanId"]], terminal="saturated"
    )
    run_workbench(state, "prepare-scan-completion", "--scan-id", parent["scanId"])
    run_workbench(state, "complete-scan", "--scan-id", parent["scanId"])
    assert (directory / "scan-manifest.json").read_bytes() == child_bytes
    context = run_workbench(state, "get-scan", "--scan-id", parent["scanId"])
    assert context["scan"]["progress"]["status"] == "complete"
    assert context["scan"]["progress"]["independentReviews"]["consolidating"] is False
    indexed = run_workbench(state, "list-global-findings")["findings"]
    assert len(indexed) == 1
    assert indexed[0]["scanId"] == parent["scanId"]
    assert indexed[0]["knownScanIds"] == [parent["scanId"]]
    assert run_workbench(state, "list-repositories")["repositories"][0]["scanCount"] == 2


@pytest.mark.parametrize("action", ["fail-scan", "cancel-scan"])
def test_stopped_standard_cannot_resume_and_preserves_checkpoint(
    tmp_path: Path, action: str
) -> None:
    target = tmp_path / "target"
    target.mkdir()
    (target / "app.py").write_text("print('fixture')\n")
    state = tmp_path / "state"
    scan = register(state, target, tmp_path / "scan")
    write_completed_contract(Path(scan["scanDir"]), scan["scanId"], target, relative_path="app.py")
    run_workbench(
        state,
        action,
        "--scan-id",
        scan["scanId"],
        *(("--message", "synthetic interruption") if action == "fail-scan" else ()),
    )
    before = (Path(scan["scanDir"]) / "scan-manifest.json").read_bytes()
    resumed = run_workbench(state, "get-cli-scan-resume", "--scan-id", scan["scanId"], check=False)
    assert "completed, failed, and canceled scans cannot resume" in resumed["stderr"]
    assert (Path(scan["scanDir"]) / "scan-manifest.json").read_bytes() == before
    assert (
        run_workbench(state, "get-scan", "--scan-id", scan["scanId"])["scan"]["findingCount"] == 1
    )


def test_native_cancel_retains_atomic_aggregate_and_marks_unmerged_child(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    (target / "app.py").write_text("print('fixture')\n")
    state = tmp_path / "state"
    parent = register(state, target, tmp_path / "scan", mode="deep")
    directory = Path(parent["scanDir"]) / "artifacts/deep-scan/passes/pass-1"
    saved = checkpoint(state, parent, passes=[{"directory": str(directory)}])
    child = register(state, target, directory, parent=parent["scanId"])
    write_completed_contract(
        directory,
        child["scanId"],
        target,
        relative_path="app.py",
        identity_anchor="separate-unmerged-finding",
    )
    run_workbench(state, "complete-scan", "--scan-id", child["scanId"])
    child_bytes = (directory / "findings.json").read_bytes()
    accepted = tmp_path / "accepted"
    accepted.mkdir()
    write_completed_contract(
        accepted,
        parent["scanId"],
        target,
        relative_path="app.py",
        identity_anchor="accepted-finding",
    )
    findings = json.loads((accepted / "findings.json").read_text())["findings"]
    saved["aggregate"] = {
        "scanId": parent["scanId"],
        "findings": findings,
        "coverage": {
            "completeness": "partial",
            "surfaces": [],
            "explicitExclusions": [],
            "deferred": [{"reason": "Accepted pass still needs dependency review."}],
        },
    }
    run_workbench(
        state,
        "save-scan-artifact",
        "--scan-id",
        parent["scanId"],
        "--artifact-path",
        CHECKPOINT,
        input_text=json.dumps(saved),
    )
    run_workbench(state, "cancel-scan", "--scan-id", parent["scanId"])
    context = run_workbench(state, "get-scan", "--scan-id", parent["scanId"])["scan"]
    assert context["progress"]["status"] == "canceled"
    assert context["findingCount"] == 1
    retained = json.loads((Path(parent["scanDir"]) / "findings.json").read_text())["findings"]
    assert retained[0]["identity"]["anchor"] == "accepted-finding"
    coverage = json.loads((Path(parent["scanDir"]) / "coverage.json").read_text())
    assert any(row["reason"].startswith("Accepted pass still") for row in coverage["deferred"])
    assert any("artifacts/deep-scan/passes/pass-1" in row["reason"] for row in coverage["deferred"])
    assert (directory / "findings.json").read_bytes() == child_bytes
    assert (
        run_workbench(state, "get-scan", "--scan-id", child["scanId"])["scan"]["progress"]["status"]
        == "complete"
    )


@pytest.mark.parametrize("child_state", ["complete", "checkpoint"])
def test_cancel_before_first_merge_preserves_ordinary_children(
    tmp_path: Path, child_state: str
) -> None:
    target = tmp_path / "target"
    target.mkdir()
    (target / "app.py").write_text("\n" * 50)
    state = tmp_path / "state"
    parent = register(state, target, tmp_path / "scan", mode="deep")
    parent_dir = Path(parent["scanDir"])
    children = []
    for index in (1, 2):
        directory = parent_dir / f"artifacts/deep-scan/passes/pass-{index}"
        child = register(state, target, directory, parent=parent["scanId"])
        write_completed_contract(directory, child["scanId"], target, relative_path="app.py")
        findings_path = directory / "findings.json"
        findings = json.loads(findings_path.read_text())["findings"]
        findings[0]["provenance"]["candidateId"] = "shared-candidate"
        findings[0]["writeup"] = {"reportPath": "findings/proof/proof.md"}
        report_dir = directory / "findings/proof"
        report_dir.mkdir(parents=True)
        (report_dir / "proof.md").write_text(f"# Observation {index}\n[Trace](trace.txt)\n")
        (report_dir / "trace.txt").write_text(f"trace-{index}\n")
        findings_path.write_text(json.dumps({"scanId": child["scanId"], "findings": findings}))
        (directory / "artifacts").mkdir()
        (directory / "artifacts/receipt.json").write_text(json.dumps({"pass": index}))
        coverage_path = directory / "coverage.json"
        coverage = json.loads(coverage_path.read_text())
        coverage["completeness"] = "partial"
        coverage["surfaces"] = [
            {
                "id": "shared-surface",
                "label": f"Pass {index}",
                "disposition": "needs_follow_up",
                "candidateId": "coverage-candidate",
                "receiptRefs": ["artifacts/receipt.json"],
            }
        ]
        coverage["deferred"] = [
            {
                "id": "shared-deferred",
                "reason": "Dependency review remains.",
                "surfaceIds": ["shared-surface"],
            }
        ]
        coverage_path.write_text(json.dumps(coverage))
        if child_state == "complete":
            run_workbench(state, "complete-scan", "--scan-id", child["scanId"])
            findings = json.loads(findings_path.read_text())["findings"]
            protected = {
                name: (directory / name).read_bytes()
                for name in (
                    "scan-manifest.json",
                    "findings.json",
                    "coverage.json",
                )
            }
        else:
            write_checkpoint(
                directory / "checkpoints",
                {
                    "scanId": child["scanId"],
                    "findings": findings,
                    "coverage": coverage,
                    "complete": False,
                },
            )
            for name in ("scan-manifest.json", "findings.json", "coverage.json"):
                (directory / name).unlink()
            protected = {}
        children.append((child, directory, findings[0], protected))
    saved = checkpoint(
        state,
        parent,
        passes=[
            {
                "directory": directory.relative_to(parent_dir).as_posix(),
                "scanId": child["scanId"],
            }
            for child, directory, _, _ in children
        ],
    )
    saved["aggregate"] = None
    run_workbench(
        state,
        "save-scan-artifact",
        "--scan-id",
        parent["scanId"],
        "--artifact-path",
        CHECKPOINT,
        input_text=json.dumps(saved),
    )
    run_workbench(state, "cancel-scan", "--scan-id", parent["scanId"])
    assert (
        run_workbench(state, "get-scan", "--scan-id", parent["scanId"])["scan"]["findingCount"] == 2
    )
    assert [scan["scanId"] for scan in run_workbench(state, "list-scans")["scans"]] == [
        parent["scanId"]
    ]
    retained = json.loads((parent_dir / "findings.json").read_text())["findings"]
    coverage = json.loads((parent_dir / "coverage.json").read_text())
    assert coverage["completeness"] == "partial"
    for child, directory, original, protected in children:
        source_id = f"{child['scanId']}:0"
        finding = next(
            value for value in retained if value["provenance"]["sourceFindingIds"] == [source_id]
        )
        source = finding["provenance"]["sourceFindings"][0]
        assert source["id"] == source_id
        if child_state == "complete":
            assert source["finding"] == original
        else:
            for field in ("codeEvidence", "locations", "validation", "writeup"):
                assert source["finding"][field] == original[field]
        report = parent_dir / finding["writeup"]["reportPath"]
        assert report.read_bytes() == (directory / "findings/proof/proof.md").read_bytes()
        assert (report.parent / "trace.txt").read_bytes() == (
            directory / "findings/proof/trace.txt"
        ).read_bytes()
        row = next(
            row for row in coverage["surfaces"] if row["id"] == f"{child['scanId']}/shared-surface"
        )
        receipt = f"{directory.relative_to(parent_dir).as_posix()}/artifacts/receipt.json"
        assert row["receiptRefs"] == [receipt]
        assert (parent_dir / receipt).is_file()
        assert row["candidateId"].startswith(child["scanId"] + ":")
        deferred = next(
            row for row in coverage["deferred"] if row["id"] == f"{child['scanId']}/shared-deferred"
        )
        assert deferred["surfaceIds"] == [row["id"]]
        for name, contents in protected.items():
            assert (directory / name).read_bytes() == contents
    assert json.loads((parent_dir / CHECKPOINT).read_text()) == saved
    manifest = json.loads((parent_dir / "scan-manifest.json").read_text())["scan"]
    assert manifest["status"] == "canceled"
    assert manifest["sealedAt"]
    assert manifest["preservedSources"]


def test_running_pass_retains_paid_receipt_before_resume_and_failure(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    (target / "app.py").write_text("print('fixture')\n")
    state = tmp_path / "state"
    scan = register(state, target, tmp_path / "scan")
    run_workbench(state, "set-scan-thread", "--scan-id", scan["scanId"], "--thread-id", "paid-pass")
    cost = {
        "model": "synthetic-model",
        "inputTokens": 10,
        "cachedInputTokens": 0,
        "cacheWriteInputTokens": 0,
        "outputTokens": 5,
        "estimatedUsd": 0.001,
    }
    receipt = run_workbench(
        state, "preserve-scan-results", "--scan-id", scan["scanId"], "--cost-json", json.dumps(cost)
    )["scan"]
    assert receipt["progress"]["status"] == "running"
    assert receipt["cost"] == cost
    assert (
        run_workbench(state, "get-cli-scan-resume", "--scan-id", scan["scanId"])["threadId"]
        == "paid-pass"
    )
    assert (
        run_workbench(state, "list-scans", "--scan-root", scan["scanDir"])["scans"][0]["cost"]
        == cost
    )
    run_workbench(state, "fail-scan", "--scan-id", scan["scanId"], "--message", "Retry exhausted.")
    assert run_workbench(state, "get-scan", "--scan-id", scan["scanId"])["scan"]["cost"] == cost


def test_native_budget_completion_checks_claim_before_publication(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    (target / "app.py").write_text("print('fixture')\n")
    state = tmp_path / "state"
    scan = run_workbench(
        state,
        "begin-deep-scan",
        "--target-path",
        str(target),
        "--thread-id",
        "native-owner",
        "--scan-root",
        str(tmp_path / "scans"),
    )["scan"]
    token = scan["handoffClaimToken"]
    run_workbench(
        state,
        "register-cli-scan",
        "--repository",
        str(target),
        "--scan-dir",
        scan["scanDir"],
        "--registration-json-stdin",
        input_text=json.dumps(
            {
                "scanId": scan["scanId"],
                "threadId": "native-owner",
                "claimToken": token,
                "recipe": {**recipe(target, "deep"), "maxCostUsd": 0.001},
            }
        ),
    )
    run_workbench(
        state,
        "save-scan-artifact",
        "--scan-id",
        scan["scanId"],
        "--artifact-path",
        CHECKPOINT,
        "--claim-token",
        token,
        input_text=json.dumps(
            {
                "version": 2,
                "passes": [],
                "mergedScanIds": [],
                "aggregate": None,
                "terminalReason": "capped",
            }
        ),
    )
    directory = Path(scan["scanDir"])
    write_completed_contract(
        directory, scan["scanId"], target, relative_path="app.py", coverage_mode="deep_repository"
    )
    original = (directory / "coverage.json").read_bytes()
    cost = {
        "model": "synthetic-model",
        "inputTokens": 10,
        "cachedInputTokens": 0,
        "cacheWriteInputTokens": 0,
        "outputTokens": 5,
        "estimatedUsd": 0.002,
    }
    arguments = (
        "complete-budget-exhausted-scan",
        "--scan-id",
        scan["scanId"],
        "--cost-json",
        json.dumps(cost),
    )
    rejected = run_workbench(state, *arguments, check=False)
    assert "owned by another continuation" in rejected["stderr"]
    assert (directory / "coverage.json").read_bytes() == original
    completed = run_workbench(state, *arguments, "--claim-token", token)["scan"]
    assert completed["progress"]["status"] == "complete"
    joined = run_workbench(
        state,
        "begin-deep-scan",
        "--scan-id",
        scan["scanId"],
        "--thread-id",
        "native-owner",
        "--claim-token",
        token,
    )["scan"]
    assert joined["progress"]["status"] == "complete"
