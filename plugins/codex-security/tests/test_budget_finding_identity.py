from __future__ import annotations

import hashlib
import json
from argparse import Namespace

import pytest
from test_accepted_publication_references import accept_reducer
from test_deep_scan_successful_publication import publication_scan as publication_scan
from test_workbench_db import BUDGET_COST


@pytest.mark.parametrize("identity_kind", ["omitted", "candidate", "authored"])
def test_budget_publication_identifies_accepted_semantic_findings(
    workbench_api, workbench_db, publication_scan, identity_kind
):
    scan = publication_scan()
    finding = scan.findings[0]
    finding["title"] = "Archive extraction crosses output boundary"
    finding.pop("identity", None)
    finding.pop("extensions", None)
    expected = {"anchor": "archive-extraction-crosses-output-boundary"}
    if identity_kind == "candidate":
        finding["extensions"] = {"candidateId": "archive-candidate"}
        expected = {"anchor": "archive-candidate"}
    elif identity_kind == "authored":
        finding["identity"] = {"anchor": "authored-anchor", "instance": "first-route"}
        expected = finding["identity"].copy()
    _, accepted, _ = accept_reducer(workbench_db, scan)
    original = accepted.read_bytes()
    for name in ("scan-manifest.json", "findings.json", "coverage.json"):
        (scan.scan_dir / name).unlink()
    with workbench_db:
        recipe = json.loads(workbench_db.execute("SELECT recipe_json FROM scans").fetchone()[0])
        recipe["maxCostUsd"] = 0.005
        workbench_db.execute("UPDATE scans SET recipe_json = ?", (json.dumps(recipe),))
        workbench_db.execute(
            "UPDATE deep_scan_runs SET status = 'running', phase = 'discovery', "
            "workflow_version = 'deep-security-scan/v2', manifest_path = NULL, "
            "terminal_reason = NULL, completed_at = NULL"
        )
    workbench_api["complete_budget_exhausted_scan"](
        workbench_db,
        Namespace(scan_id=scan.scan_id, cost_json=json.dumps(BUDGET_COST), message=None),
    )
    published = json.loads((scan.scan_dir / "findings.json").read_text())["findings"]
    assert len(published) == 1
    assert published[0]["identity"] == expected
    assert published[0]["codeEvidence"] == finding["codeEvidence"]
    assert published[0]["remediation"] == finding["remediation"]
    assert accepted.read_bytes() == original
    selection = json.loads(
        workbench_db.execute("SELECT finalization_input_json FROM deep_scan_runs").fetchone()[0]
    )
    assert selection["resultSha256"] == hashlib.sha256(original).hexdigest()
    assert workbench_db.execute("SELECT status FROM scans").fetchone()[0] == "complete"
