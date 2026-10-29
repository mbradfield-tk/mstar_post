"""API tests on a synthetic M-Star layout (run: python3 -m pytest -q backend/tests)."""
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
pv = pytest.importorskip("pyvista")
vtk = pytest.importorskip("vtk")

from app import auth, config, jobs  # noqa: E402

PASSWORD = "pw"  # the patched password check accepts any user with this password


def login(c, user: str) -> None:
    r = c.post("/api/login", json={"user": user, "password": PASSWORD})
    assert r.status_code == 200, r.text


def logout(c) -> None:
    c.post("/api/logout")
    c.cookies.clear()

FLUID_HEADER = ["Time [s]", "Fluid Volume [m^3]", "Mean Velocity [m/s]",
                "Mean Energy Dissipation Rate [W/kg]"]


def write_vti(path: Path, dims, origin, raw: bool, t: float) -> np.ndarray:
    """ImageData with cell arrays; raw=True mimics M-Star (uncompressed, appended raw)."""
    img = pv.ImageData(dimensions=[d + 1 if d > 0 else 1 for d in dims],
                       origin=origin, spacing=(0.01, 0.01, 0.01))
    n = img.n_cells
    vel = np.zeros((n, 3), np.float32)
    vel[:, 0] = np.arange(n, dtype=np.float32)
    img.cell_data["Velocity Vector (m/s)"] = vel
    frac = np.ones(n, np.float32)
    frac[:5] = 0.0  # "solid" cells
    img.cell_data["Fluid 1 (Water) Volume Fraction (-)"] = frac
    img.cell_data["Fluid 2 (Oil) Volume Fraction (-)"] = np.zeros(n, np.float32)
    img.field_data["TIME"] = np.array([t])
    path.parent.mkdir(parents=True, exist_ok=True)
    w = vtk.vtkXMLImageDataWriter()
    w.SetFileName(str(path))
    w.SetInputData(img)
    if raw:
        w.SetDataModeToAppended()
        w.EncodeAppendedDataOff()
        w.SetCompressorTypeToNone()
        w.SetHeaderTypeToUInt64()
    w.Write()
    return vel[:, 0].reshape(dims[::-1] if all(dims) else
                             tuple(max(d, 1) for d in dims)[::-1])


def make_case(case: Path, raw: bool = True) -> None:
    (case / "input.xml").parent.mkdir(parents=True, exist_ok=True)
    (case / "input.xml").write_text(
        "<input><system><dx>0.01</dx><dt>0.001</dt></system></input>")
    stats = case / "out" / "Stats"
    stats.mkdir(parents=True)
    t = np.arange(0, 4.0001, 0.1)
    with open(stats / "Fluid.txt", "w") as fh:
        fh.write("\t".join(FLUID_HEADER) + "\n")
        for ti in t:
            fh.write(f"{ti:g}\t0.001\t{0.1 if ti > 1 else ti / 10:g}\t1\n")
    out = case / "out" / "Output"
    for ti in (1.0, 2.0):
        write_vti(out / "Volume" / "block0" / f"Volume.{ti:.5e}.vti", (6, 5, 4),
                  (0, 0, 0), raw, ti)
        write_vti(out / "SliceY_0.020" / "block0" / f"Slice.{ti:.5e}.vti", (6, 0, 4),
                  (0, 0.02, 0), raw, ti)
        s = pv.Sphere(radius=0.01, center=(0.03, 0.02, 0.02))
        s.field_data["TIME"] = np.array([ti])
        (out / "VolumeVOFSurface" / "block0").mkdir(parents=True, exist_ok=True)
        s.save(out / "VolumeVOFSurface" / "block0" / f"VOFSurface.{ti:.5e}.vtp")
    pv.Cube().save(case / "Vessel.stl")


@pytest.fixture
def client(tmp_path, monkeypatch):
    root = tmp_path / "data"
    make_case(root / "R1" / "caseA")
    make_case(root / "R1" / "caseB", raw=False)
    make_case(root / "R2" / "caseA")
    monkeypatch.setattr(config, "ROOTS", [root.resolve()])
    monkeypatch.setattr(config, "WRITE_ROOTS", [root.resolve()])
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "app")
    monkeypatch.setattr(config, "PROJECTS_DIR", tmp_path / "app" / "projects")
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "app" / "cache")
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "app" / "jobs.db")
    monkeypatch.setattr(config, "SECRET_PATH", tmp_path / "app" / "secret.key")
    monkeypatch.setattr(config, "HELPER_MODE", "direct")
    monkeypatch.setattr(auth, "verify_password", lambda u, p: (p == PASSWORD, "" if p == PASSWORD else "bad password"))
    auth._fail_log.clear()
    (tmp_path / "app").mkdir()
    from fastapi.testclient import TestClient

    from app.main import app
    jobs.manager.__init__()
    with TestClient(app) as c:
        c.root = root.resolve()
        login(c, "tester")
        yield c


def snapshot(root: Path) -> list:
    return sorted((p, p.stat().st_mtime_ns) for p in root.rglob("*"))


def test_tunnel_identity(tmp_path, monkeypatch):
    """The owner of a loopback client socket is found in /proc/net/tcp (SSH tunnel login)."""
    import os
    import socket
    monkeypatch.setattr(config, "SECRET_PATH", tmp_path / "secret.key")
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    cli = socket.create_connection(srv.getsockname())
    conn, _ = srv.accept()
    try:
        ip, port = cli.getsockname()
        assert auth._socket_uid(ip, port, srv.getsockname()[1]) == os.getuid()
        assert auth._socket_uid(ip, port, srv.getsockname()[1] + 1 if srv.getsockname()[1] < 65535 else 1) is None
    finally:
        conn.close(); cli.close(); srv.close()
    assert auth.read_token(auth.make_token("ann")) == "ann"
    assert auth.read_token(auth.make_token("ann")[:-2] + "zz") is None


def test_helpers_as_user(client, tmp_path, monkeypatch):
    """Hosted mode: file operations and jobs go through the helpers as the logged-in
    user. A fake sudo (drops "-u <user>", runs the helper as us) exercises the protocol."""
    import os
    import stat as st
    hd = tmp_path / "helpers"
    hd.mkdir()
    for src, dst in (("fs_helper.py", "fs"), ("run_helper.py", "run")):
        (hd / dst).write_text((config.HELPER_SRC / src).read_text())
        os.chmod(hd / dst, 0o755)
    fake = tmp_path / "fakesudo"
    fake.write_text("#!/bin/sh\nshift 2\nexec \"$@\"\n")  # sudo -u USER cmd... -> cmd...
    os.chmod(fake, 0o755)
    conf = tmp_path / "helper.conf"
    conf.write_text(json.dumps({"tasks": {"stats_summary": [config.STATS_SUMMARY_PY, str(config.STATS_SUMMARY)]},
                                "interpreters": [sys.executable]}))
    monkeypatch.setenv("MSTAR_POST_HELPER_CONF", str(conf))
    monkeypatch.setattr(config, "HELPER_DIR", hd)
    monkeypatch.setattr(config, "HELPER_MODE", "sudo")
    monkeypatch.setattr(config, "SUDO", [str(fake)])
    # "tester" is not the server account -> helper path
    assert client.get("/api/fs/whoami").json() == {"uid": os.getuid(), "user": auth.server_account(), "mode": "sudo"}
    b = client.get("/api/fs/browse", params={"path": str(client.root)}).json()
    assert [e["name"] for e in b["entries"]] == ["R1", "R2"]
    assert client.post("/api/fs/mkdirs", json={"parent": str(client.root / "R2"), "names": ["viahelper"]}).json()["created"] == ["viahelper"]
    assert (client.root / "R2" / "viahelper").is_dir()
    assert client.get("/api/fs/read", params={"path": str(client.root / "R1" / "caseA" / "input.xml")}).json()["text"].startswith("<input>")
    assert client.get("/api/fs/browse", params={"path": "/etc"}).status_code == 403
    # streaming ops through the helper process: upload (put) and download (cat, also zipped)
    r = client.post("/api/fs/upload", data={"parent": str(client.root / "R2")},
                    files=[("files", ("h.bin", bytes(range(256)) * 5000, "application/octet-stream"))]).json()
    assert r["saved"] == [{"name": "h.bin", "bytes": 1280000}] and (client.root / "R2" / "h.bin").stat().st_size == 1280000
    r = client.get("/api/fs/download", params={"path": str(client.root / "R2" / "h.bin")})
    assert r.status_code == 200 and len(r.content) == 1280000 and r.content[:3] == b"\x00\x01\x02"
    assert client.get("/api/fs/download", params={"path": "/etc/passwd"}).status_code == 403
    import io, zipfile
    r = client.get("/api/fs/download", params={"path": [str(client.root / "R2" / "h.bin"), str(client.root / "R1" / "caseA" / "input.xml")]})
    assert zipfile.ZipFile(io.BytesIO(r.content)).namelist() == ["h.bin", "input.xml"]
    p = client.post("/api/projects", json={"name": "hosted", "root": str(client.root)}).json()
    assert all(c["id_written"] for c in p["cases"])  # marker written through the helper
    run_dir = config.PROJECTS_DIR / p["id"] / "runs"
    j = client.post(f"/api/projects/{p['id']}/run", json={"task": "stats_summary", "params": {"time": 1.5}}).json()
    j = wait(client, j["id"])
    log = client.get(f"/api/jobs/{j['id']}/log").json()["text"]
    assert j["status"] == "done", log
    assert "/run --task stats_summary --" in log and (Path(j["run_dir"]) / "batch_summary_means.csv").is_file()
    assert st.S_IMODE(Path(j["run_dir"]).stat().st_mode) == 0o2775
    assert run_dir.is_dir()
    # a guest never triggers helper calls
    logout(client)
    assert client.get(f"/api/projects/{p['id']}").status_code == 200


def test_task_registry_base_and_addons(client):
    from app import tasks as T
    ts = {t["id"]: t for t in client.get("/api/tasks").json()}
    assert ts["stats_summary"]["group"] == "base" and ts["dispersion"]["group"] == "addon"
    assert not any(p["name"] in ("dispersion", "uniformity") for p in ts["stats_summary"]["params"])
    p = {"id": "x", "single": False, "root": "/r", "ref_case": "a"}
    cases = [{"id": "a", "path": "/r/a"}]
    base = T.STATS.build(p, cases, T.coerce(T.STATS, {}), Path("/tmp/run"))
    assert "--dispersion" not in base[0]["argv"] and "--addons-only" not in base[0]["argv"] and "--plot" not in base[0]["argv"]
    disp = T.DISPERSION.build(p, cases, T.coerce(T.DISPERSION, {"sigma": 0.03}), Path("/tmp/run"))
    a = disp[0]["argv"]
    assert {"--dispersion", "--uniformity", "--addons-only"} <= set(a) and "--plot" not in a and a[a.index("--sigma") + 1] == "0.03"
    only = T.DISPERSION.build(p, cases, T.coerce(T.DISPERSION, {"uniformity": False}), Path("/tmp/run"))
    assert "--uniformity" not in only[0]["argv"]
    # the dispersion add-on runs the stats script, so the root launcher uses that task id
    assert "stats_summary" in jobs.launcher_argv("dispersion", a, "bob") and "dispersion" not in jobs.launcher_argv("dispersion", a, "bob")[:8]


def test_guest_and_login(client):
    p = client.post("/api/projects", json={"name": "g", "root": str(client.root)}).json()
    assert client.get("/api/whoami").json()["user"] == "tester"
    logout(client)
    w = client.get("/api/whoami").json()
    assert w["user"] is None and w["method"] == "none"
    # guests read everything but change nothing
    assert client.get("/api/projects").status_code == 200
    assert client.get(f"/api/projects/{p['id']}").status_code == 200
    assert client.get("/api/cases").status_code == 200
    assert client.get("/api/fs/browse", params={"path": str(client.root)}).status_code == 401
    assert client.post("/api/projects", json={"name": "x", "root": str(client.root)}).status_code == 401
    assert client.patch(f"/api/projects/{p['id']}", json={"included": {"R1/caseA": False}}).status_code == 401
    assert client.post(f"/api/projects/{p['id']}/run", json={"task": "stats_summary"}).status_code == 401
    assert client.delete(f"/api/projects/{p['id']}").status_code == 401
    # wrong password, throttling, then a good login
    assert client.post("/api/login", json={"user": "tester", "password": "nope"}).status_code == 401
    for _ in range(4):
        client.post("/api/login", json={"user": "tester", "password": "nope"})
    assert client.post("/api/login", json={"user": "tester", "password": PASSWORD}).status_code == 429
    auth._fail_log.clear()
    login(client, "bob")
    assert client.get("/api/whoami").json() == {"user": "bob", "method": "password", "admin": False,
                                                 "password_login": False, "server_account": auth.server_account()}
    # bob may edit but not delete tester's project; the server account is an admin
    assert client.patch(f"/api/projects/{p['id']}", json={"included": {"R1/caseA": False}}).status_code == 200
    assert client.delete(f"/api/projects/{p['id']}").status_code == 403
    assert client.patch(f"/api/projects/{p['id']}", json={"owner": "bob"}).status_code == 403
    logout(client)
    login(client, auth.server_account())
    assert client.get("/api/whoami").json()["admin"]
    assert client.delete(f"/api/projects/{p['id']}").status_code == 200
    assert client.get("/api/fs/whoami").json()["mode"] == "direct"


def test_path_guard(client, tmp_path):
    assert client.get("/api/fs/list", params={"path": "/etc"}).status_code == 403
    r = client.get("/api/fs/list", params={"path": str(client.root / ".." / "app")})
    assert r.status_code == 403
    r = client.get("/api/fs/list", params={"path": str(client.root)})
    assert [e["name"] for e in r.json()["entries"]] == ["R1", "R2"]
    r = client.get("/api/fs/list", params={"path": str(client.root / "R1")})
    assert all(e["is_case"] for e in r.json()["entries"])


def test_browse_and_du(client):
    d = client.root / "R1" / "blob"
    d.mkdir()
    (d / "a.bin").write_bytes(b"x" * 5000)
    (d / "sub").mkdir()
    (d / "sub" / "b.bin").write_bytes(b"y" * 3000)
    r = client.get("/api/fs/browse", params={"path": str(d)}).json()
    assert [(e["name"], e["dir"], e["size"]) for e in r["entries"]] == [("a.bin", False, 5000), ("sub", True, None)]
    assert r["disk"]["total"] > 0 and r["parent"] == str(client.root / "R1")
    u = client.get("/api/fs/du", params={"path": str(d)}).json()
    assert (u["apparent"], u["files"], u["dirs"], u["truncated"]) == (8000, 2, 1, False)
    assert client.get("/api/fs/du", params={"path": str(d)}).json()["cached"]
    assert client.get("/api/fs/du", params={"path": "/etc"}).status_code == 403
    assert client.get("/api/fs/browse", params={"path": str(d / "a.bin")}).status_code == 422


def test_fs_read(client):
    d = client.root / "R1"
    (d / "log.txt").write_text("".join(f"line {i}\n" for i in range(100)))
    (d / "x.bin").write_bytes(b"\0\1ABC")
    (d / "p.png").write_bytes(b"\x89PNG\r\n")
    r = client.get("/api/fs/read", params={"path": str(d / "log.txt"), "limit": 14}).json()
    assert (r["text"], r["offset"], r["end"], r["binary"]) == ("line 0\nline 1\n", 0, 14, False)
    r = client.get("/api/fs/read", params={"path": str(d / "log.txt"), "limit": 8, "tail": True}).json()
    assert r["text"] == "line 99\n" and r["end"] == r["size"]
    r = client.get("/api/fs/read", params={"path": str(d / "x.bin")}).json()
    assert r["binary"] and r["text"].startswith("00000000  00 01 41 42 43") and r["text"].endswith("..ABC")
    r = client.get("/api/fs/image", params={"path": str(d / "p.png")})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert client.get("/api/fs/image", params={"path": str(d / "log.txt")}).status_code == 422
    # CAD preview: STL files come back as they are; other extensions are refused
    r = client.get("/api/fs/mesh", params={"path": str(client.root / "R1" / "caseA" / "Vessel.stl")})
    assert r.status_code == 200 and r.headers["content-type"].startswith("model/stl") and r.headers["x-mesh-source"] == "stl"
    assert len(r.content) == (client.root / "R1" / "caseA" / "Vessel.stl").stat().st_size
    assert client.get("/api/fs/mesh", params={"path": str(d / "log.txt")}).status_code == 422
    assert client.get("/api/fs/read", params={"path": "/etc/passwd"}).status_code == 403
    assert client.get("/api/fs/read", params={"path": str(d)}).status_code == 422


def test_fs_create_and_delete(client, monkeypatch):
    d = client.root / "R2"
    r = client.post("/api/fs/mkdirs", json={"parent": str(d), "names": ["1_A_10L", "2_B_10L", "caseA", "a/b", ".."]}).json()
    assert r["created"] == ["1_A_10L", "2_B_10L"]
    assert [s["name"] for s in r["skipped"]] == ["caseA", "a/b", ".."]
    assert (d / "1_A_10L").is_dir()
    assert client.post("/api/fs/file", json={"parent": str(d / "1_A_10L"), "name": "notes.txt",
                                              "content": "hi"}).status_code == 200
    assert (d / "1_A_10L" / "notes.txt").read_text() == "hi"
    assert client.post("/api/fs/file", json={"parent": str(d / "1_A_10L"), "name": "notes.txt"}).status_code == 409
    assert client.post("/api/fs/delete", json={"path": str(d / "1_A_10L")}).status_code == 409
    assert client.post("/api/fs/delete", json={"path": str(d / "1_A_10L"), "recursive": True}).status_code == 200
    assert not (d / "1_A_10L").exists()
    assert client.post("/api/fs/delete", json={"path": str(d / "2_B_10L")}).status_code == 200
    (d / "old").mkdir()
    (d / "taken").mkdir()
    r = client.post("/api/fs/rename", json={"path": str(d / "old"), "name": "new"})
    assert r.status_code == 200 and (d / "new").is_dir() and not (d / "old").exists()
    assert client.post("/api/fs/rename", json={"path": str(d / "new"), "name": "taken"}).status_code == 409
    assert client.post("/api/fs/rename", json={"path": str(d / "new"), "name": "a/b"}).status_code == 422
    assert client.post("/api/fs/rename", json={"path": str(client.root), "name": "x"}).status_code == 403
    # move: into an existing folder, never overwriting, not into itself, roots refused
    (d / "new" / "f.txt").write_text("x")
    (d / "taken" / "new").mkdir()
    r = client.post("/api/fs/move", json={"paths": [str(d / "new" / "f.txt"), str(d / "new"), str(d / "missing")],
                                          "dest": str(d / "taken")}).json()
    assert r["moved"] == [str(d / "taken" / "f.txt")] and (d / "taken" / "f.txt").is_file()
    assert [s["reason"][:10] for s in r["skipped"]] == ["already ex", "not found:"]
    r = client.post("/api/fs/move", json={"paths": [str(d / "new")], "dest": str(d / "new")}).json()
    assert "into itself" in r["skipped"][0]["reason"]
    r = client.post("/api/fs/move", json={"paths": [str(client.root)], "dest": str(d / "taken")}).json()
    assert r["moved"] == [] and r["skipped"][0]["reason"].startswith(("refusing", "outside"))
    assert client.post("/api/fs/move", json={"paths": [str(d / "new")], "dest": "/etc"}).status_code == 403
    # upload (never overwrites unless asked) and download (single file, zip of several)
    r = client.post("/api/fs/upload", data={"parent": str(d)}, files=[("files", ("up.txt", b"hello", "text/plain")),
                                                                   ("files", ("big.bin", bytes(3000), "application/octet-stream"))]).json()
    assert [s["name"] for s in r["saved"]] == ["up.txt", "big.bin"] and (d / "up.txt").read_text() == "hello"
    r = client.post("/api/fs/upload", data={"parent": str(d)}, files=[("files", ("up.txt", b"again", "text/plain"))]).json()
    assert r["skipped"][0]["reason"].startswith("already exists") and (d / "up.txt").read_text() == "hello"
    r = client.post("/api/fs/upload", data={"parent": str(d), "overwrite": "true"}, files=[("files", ("up.txt", b"again", "text/plain"))]).json()
    assert r["saved"] and (d / "up.txt").read_text() == "again"
    assert client.post("/api/fs/upload", data={"parent": "/etc"}, files=[("files", ("x", b"1"))]).json()["skipped"][0]["reason"].startswith(("not writable", "outside"))
    r = client.get("/api/fs/download", params={"path": str(d / "up.txt")})
    assert r.status_code == 200 and r.content == b"again" and "up.txt" in r.headers["content-disposition"]
    assert client.get("/api/fs/download", params={"path": str(d)}).status_code == 422
    r = client.get("/api/fs/download", params={"path": [str(d / "up.txt"), str(d / "big.bin")]})
    import io, zipfile
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert r.headers["content-type"] == "application/zip" and z.namelist() == ["up.txt", "big.bin"] \
        and z.read("up.txt") == b"again" and len(z.read("big.bin")) == 3000
    r = client.post("/api/fs/download", data={"path": [str(d / "up.txt"), str(d / "big.bin")], "name": "pick"})
    assert r.status_code == 200 and "pick.zip" in r.headers["content-disposition"] \
        and zipfile.ZipFile(io.BytesIO(r.content)).namelist() == ["up.txt", "big.bin"]
    assert client.post("/api/fs/delete", json={"path": str(client.root), "recursive": True}).status_code == 403
    assert client.post("/api/fs/delete", json={"path": str(d / ".." / "R1")}).status_code == 422
    assert client.post("/api/fs/mkdirs", json={"parent": "/etc", "names": ["x"]}).status_code == 403
    monkeypatch.setattr(config, "WRITE_ROOTS", [d / "nowhere"])
    assert client.post("/api/fs/mkdirs", json={"parent": str(d), "names": ["x"]}).status_code == 403
    assert client.get("/api/fs/browse", params={"path": str(d)}).json()["writable"] is False


def test_case_uids(client):
    p = client.post("/api/projects", json={"name": "u1", "root": str(client.root)}).json()
    uids = {c["id"]: c["uid"] for c in p["cases"]}
    assert len(set(uids.values())) == 3 and all(len(u) == 12 for u in uids.values())
    marker = json.loads((client.root / "R1" / "caseA" / "mstar_post_case.json").read_text())
    assert marker["uid"] == uids["R1/caseA"] and marker["created_by"] == "tester"
    assert all(c["id_written"] for c in p["cases"])
    # the same folder in a second project keeps its uid (read from the marker)
    p2 = client.post("/api/projects", json={"name": "u2", "root": str(client.root / "R1")}).json()
    assert {c["uid"] for c in p2["cases"]} == {uids["R1/caseA"], uids["R1/caseB"]}
    # a renamed folder keeps its uid after relocate
    (client.root / "R2").rename(client.root / "R2x")
    g = client.post(f"/api/projects/{p['id']}/relocate", json={"cases": {"R2/caseA": str(client.root / "R2x" / "caseA")}}).json()
    assert next(c for c in g["cases"] if c["id"] == "R2/caseA")["uid"] == uids["R2/caseA"]
    rows = client.get("/api/cases").json()
    assert len(rows) == 3  # one row per uid across both projects
    a = next(r for r in rows if r["uid"] == uids["R1/caseA"])
    assert sorted(x["id"] for x in a["projects"]) == sorted([p["id"], p2["id"]])
    assert a["info"]["end_time_s"] == pytest.approx(4.0) and a["name"] == "caseA"


def test_project_metadata(client):
    p = client.post("/api/projects", json={"name": "meta", "root": str(client.root), "owner": "someone else",
                                              "program": " TAK-360 ", "purpose": "pipeline"}).json()
    assert (p["owner"], p["program"], p["purpose"]) == ("tester", "TAK-360", "pipeline")  # owner = the creating account
    # the owner is fixed: even its creator (or an admin) cannot change it; same value is a no-op
    assert client.patch(f"/api/projects/{p['id']}", json={"owner": "Bob"}).status_code == 403
    p = client.patch(f"/api/projects/{p['id']}", json={"owner": "tester", "purpose": "x" * 100}).json()
    assert p["owner"] == "tester" and len(p["purpose"]) == 80 and p["program"] == "TAK-360"
    s = next(x for x in client.get("/api/projects").json() if x["id"] == p["id"])
    assert (s["owner"], s["program"]) == ("tester", "TAK-360")


def test_project_and_inventory(client):
    p = client.post("/api/projects", json={"name": "step 8", "root": str(client.root)}).json()
    assert [c["id"] for c in p["cases"]] == ["R1/caseA", "R1/caseB", "R2/caseA"]
    assert p["id"] == "step-8"
    p = client.patch(f"/api/projects/{p['id']}",
                     json={"included": {"R1/caseB": False}, "ref_case": "R2/caseA"}).json()
    assert [c["included"] for c in p["cases"]] == [True, False, True]
    info = client.get(f"/api/projects/{p['id']}").json()["cases"][0]["info"]
    assert info["end_time_s"] == pytest.approx(4.0)
    assert info["settings"]["dx [m]"] == pytest.approx(0.01)

    case = str(client.root / "R1" / "caseA")
    inv = client.get("/api/case/inventory", params={"path": case}).json()
    kinds = {k["kind"]: k for k in inv["kinds"]}
    assert kinds["Volume"]["type"] == "volume" and kinds["Volume"]["times"] == [1.0, 2.0]
    units = {a["name"]: a["unit"] for a in kinds["Volume"]["arrays"]}
    assert units["Fluid 1 (Water) Volume Fraction (-)"] == "m^3/m^3"
    assert units["Velocity Vector (m/s)"] == "m/s"
    assert kinds["SliceY_0.020"]["type"] == "slice"
    assert kinds["SliceY_0.020"]["slice_axis"] == 1
    assert kinds["VolumeVOFSurface"]["type"] == "surface"
    assert [g["name"] for g in inv["geometry"]] == ["Vessel"]

    s = client.get("/api/case/series", params={"path": case, "file": "Fluid.txt",
                                               "columns": ["Mean Velocity [m/s]"]}).json()
    assert len(s["t"]) == 41 and s["columns"]["Mean Velocity [m/s]"][-1] == 0.1
    # decimation keeps the extremes of every bucket, not just every k-th sample
    s = client.get("/api/case/series", params={"path": case, "file": "Fluid.txt",
                                               "columns": ["Mean Velocity [m/s]"], "max_points": 5}).json()
    v = s["columns"]["Mean Velocity [m/s]"]
    assert 5 <= len(v) <= 12 and s["t"][0] == 0 and s["t"][-1] == 4.0
    assert max(v) == 0.1 and v[-1] == 0.1


@pytest.mark.parametrize("case_id", ["R1/caseA", "R1/caseB"])  # raw memmap / compressed
def test_planes(client, case_id):
    case = str(client.root / case_id)
    vol = "out/Output/Volume/block0/Volume.2.00000e+00.vti"
    r = client.get("/api/case/plane", params={
        "path": case, "file": vol, "array": "Velocity Vector (m/s)", "comp": "0",
        "axis": 2, "pos": 0.015})
    assert r.status_code == 200
    h = r.headers
    w, hh = int(h["x-width"]), int(h["x-height"])
    assert (w, hh) == (6, 5) and int(h["x-index"]) == 1
    d = np.frombuffer(r.content, "<f4").reshape(hh, w)
    expect = np.arange(6 * 5 * 4, dtype=np.float32).reshape(4, 5, 6)
    np.testing.assert_array_equal(d, expect[1])
    assert float(h["x-mean"]) == pytest.approx(float(expect[1].mean()))
    # fluid-volume mean: all cells unmasked; the first five cells of layer 0 are solid when masked
    m = client.get("/api/case/mean", params={"path": case, "file": vol, "array": "Velocity Vector (m/s)", "comp": "0", "mask": False}).json()
    assert m["n_cells"] == 6 * 5 * 4 and m["mean"] == pytest.approx(float(expect.mean()))
    m = client.get("/api/case/mean", params={"path": case, "file": vol, "array": "Velocity Vector (m/s)", "comp": "0"}).json()
    assert m["masked"] and m["n_cells"] == 6 * 5 * 4 - 5 and m["mean"] == pytest.approx(float(expect.ravel()[5:].mean()))
    r = client.get("/api/case/plane", params={
        "path": case, "file": vol, "array": "Velocity Vector (m/s)", "comp": "0",
        "axis": 2, "pos": 0.0})
    d = np.frombuffer(r.content, "<f4").reshape(hh, w)
    assert np.isnan(d[0, :5]).all()  # no fluid in the first five cells -> masked
    np.testing.assert_array_equal(d[1:], expect[0, 1:])
    # smooth: 1-2-1 over the neighbouring layers; interior layer 1 of a linear field is unchanged,
    # the edge layer 0 (only layer 1 as neighbour) moves towards it; masked cells stay NaN
    r = client.get("/api/case/plane", params={
        "path": case, "file": vol, "array": "Velocity Vector (m/s)", "comp": "0",
        "axis": 2, "pos": 0.015, "smooth": True})
    d = np.frombuffer(r.content, "<f4").reshape(hh, w)
    np.testing.assert_allclose(d[1:], expect[1, 1:], rtol=1e-6)
    np.testing.assert_allclose(d[0, :5], (2 * expect[1, 0, :5] + expect[2, 0, :5]) / 3, rtol=1e-6)  # solid below excluded
    r = client.get("/api/case/plane", params={
        "path": case, "file": vol, "array": "Velocity Vector (m/s)", "comp": "0",
        "axis": 2, "pos": 0.0, "smooth": True})
    d = np.frombuffer(r.content, "<f4").reshape(hh, w)
    assert np.isnan(d[0, :5]).all()
    np.testing.assert_allclose(d[1:], (2 * expect[0, 1:] + expect[1, 1:]) / 3, rtol=1e-6)
    r = client.get("/api/case/plane", params={
        "path": case, "file": vol, "array": "Velocity Vector (m/s)", "axis": 0,
        "pos": 0.0, "mask": False})
    assert (int(r.headers["x-width"]), int(r.headers["x-height"])) == (4, 5)
    r = client.get("/api/case/plane", params={
        "path": case, "file": "out/Output/SliceY_0.020/block0/Slice.1.00000e+00.vti",
        "array": "Velocity Vector (m/s)"})
    assert r.headers["x-axis"] == "1" and int(r.headers["x-width"]) == 6
    line = client.get("/api/case/line", params={
        "path": case, "file": vol, "array": "Velocity Vector (m/s)", "comp": "0",
        "p0": "0.005,0.005,0.005", "p1": "0.055,0.005,0.005", "n": 6}).json()
    assert line["value"] == [float(i) for i in range(6)]


def test_meshes(client):
    case = str(client.root / "R1" / "caseA")
    r = client.get("/api/case/surface", params={
        "path": case, "file": "out/Output/VolumeVOFSurface/block0/VOFSurface.1.00000e+00.vtp"})
    assert r.status_code == 200 and len(r.content) > 84
    r = client.get("/api/case/iso", params={
        "path": case, "file": "out/Output/Volume/block0/Volume.1.00000e+00.vti",
        "array": "Velocity Vector (m/s)", "comp": "0", "level": 60})
    n = int(np.frombuffer(r.content[80:84], "<u4")[0])
    assert r.status_code == 200 and n > 0 and len(r.content) == 84 + 50 * n
    # compact indexed mesh: same triangles, ~3x smaller
    r = client.get("/api/case/iso", params={
        "path": case, "file": "out/Output/Volume/block0/Volume.1.00000e+00.vti",
        "array": "Velocity Vector (m/s)", "comp": "0", "level": 60, "fmt": "mesh"})
    assert r.content[:4] == b"MPM1"
    npts, ntri = np.frombuffer(r.content[4:12], "<u4")
    assert ntri == n and len(r.content) == 12 + 12 * npts + 12 * ntri
    idx = np.frombuffer(r.content[12 + 12 * npts:], "<u4")
    assert idx.max() < npts
    vof = "out/Output/VolumeVOFSurface/block0/VOFSurface.1.00000e+00.vtp"
    r = client.get("/api/case/surface", params={"path": case, "file": vof, "fmt": "mesh"})
    assert r.status_code == 200 and r.content[:4] == b"MPM1"
    r = client.get("/api/case/surface_warm", params={"path": case, "file": [vof], "max_tris": 1000})
    assert r.status_code == 200 and r.json()["queued"] == 1
    assert client.get("/api/case/surface", params={"path": case, "file": vof, "fmt": "obj"}).status_code == 422
    assert client.get("/api/case/surface", params={
        "path": case, "file": "../../R2/caseA/Vessel.stl"}).status_code == 403


def test_vector_plane_and_streamlines(client):
    case = str(client.root / "R1" / "caseA")
    vol = "out/Output/Volume/block0/Volume.2.00000e+00.vti"
    r = client.get("/api/case/plane_vec", params={
        "path": case, "file": vol, "array": "Velocity Vector (m/s)", "axis": 2,
        "pos": 0.015, "mask": False})
    assert r.status_code == 200
    w, hh = int(r.headers["x-width"]), int(r.headers["x-height"])
    d = np.frombuffer(r.content, "<f4").reshape(2, hh, w)
    expect = np.arange(6 * 5 * 4, dtype=np.float32).reshape(4, 5, 6)
    np.testing.assert_array_equal(d[0], expect[1])  # u = x component
    np.testing.assert_array_equal(d[1], 0)
    assert client.get("/api/case/plane_vec", params={
        "path": case, "file": vol, "array": "Fluid 1 (Water) Volume Fraction (-)",
        "axis": 2}).status_code == 422

    r = client.get("/api/case/streamlines", params={
        "path": case, "file": vol, "array": "Velocity Vector (m/s)", "axis": 0,
        "pos": 0.03, "n_seeds": 3})
    assert r.status_code == 200
    n_pts, n_lines = np.frombuffer(r.content[:8], "<u4")
    assert n_lines > 0 and n_pts > n_lines
    xyz = np.frombuffer(r.content, "<f4", n_pts * 3, 8).reshape(-1, 3)
    off = np.frombuffer(r.content, "<u4", n_lines + 1, 8 + n_pts * 16)
    for a, b in zip(off[:-1], off[1:]):
        seg = xyz[a:b]
        assert np.ptp(seg[:, 1]) < 1e-6 and np.ptp(seg[:, 2]) < 1e-6  # along x only
        assert np.ptp(seg[:, 0]) > 0.01

    fc = client.get("/api/case/fluid_center", params={"path": case, "file": vol}).json()
    assert fc["source"] == "volume fractions"
    assert fc["center"] == pytest.approx([0.03, 0.025, 0.02])  # 6 x 5 x 4 cells of 0.01 m


def wait(client, jid, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = client.get(f"/api/jobs/{jid}").json()
        if j["status"] not in ("queued", "running"):
            return j
        time.sleep(0.2)
    raise TimeoutError(jid)


def test_stats_job_leaves_cases_untouched(client):
    p = client.post("/api/projects", json={"name": "p", "root": str(client.root)}).json()
    before = snapshot(client.root)  # after creation: the case-id marker is the only file the app adds
    assert {f.name for f, _ in before} >= {"mstar_post_case.json"}
    client.patch(f"/api/projects/{p['id']}", json={"included": {"R1/caseB": False}})
    j = client.post(f"/api/projects/{p['id']}/run",
                    json={"task": "stats_summary", "params": {"time": 1.5}}).json()
    j = wait(client, j["id"])
    log = client.get(f"/api/jobs/{j['id']}/log").json()["text"]
    assert j["status"] == "done", log
    assert snapshot(client.root) == before
    runs = client.get(f"/api/projects/{p['id']}/runs").json()
    assert "batch_summary_means.csv" in runs[0]["csvs"]
    assert "R2/caseA/stats_summary.csv" in runs[0]["csvs"]
    t = client.get(f"/api/projects/{p['id']}/csv",
                   params={"path": f"{runs[0]['path']}/batch_summary_means.csv"}).json()
    assert [r[0] for r in t["rows"]] == ["R1/caseA", "R2/caseA"]
    r = client.get(f"/api/projects/{p['id']}/zip", params={"path": runs[0]["path"]})
    assert r.status_code == 200 and r.content[:2] == b"PK"
    assert client.get(f"/api/projects/{p['id']}/file",
                      params={"path": "../../jobs.db"}).status_code == 403
    # body-name normalisation of existing results (new runs do it as a second job step)
    assert len(j["commands"]) == 2 and "--rename-body" in j["commands"][1]["argv"]
    run_dir = Path(j["run_dir"])
    (run_dir / "extra_means.csv").write_text("case,Impeller Power P (Moving Body) [W],MovingBody_agitator: x [W]\nR1/caseA,1,\nR2/caseA,,2\n")
    r = client.post(f"/api/projects/{p['id']}/rename-body", params={"run": run_dir.name}).json()
    assert r["changed"] >= 1 and r["runs"][0]["changed"] >= 1
    assert (run_dir / "extra_means.csv").read_text().splitlines()[0] == "case,Impeller Power P (Agitator) [W],MovingBody_Agitator: x [W]"
    assert client.post(f"/api/projects/{p['id']}/rename-body").json()["changed"] == 0  # idempotent


def test_run_timeseries(client):
    p = client.post("/api/projects", json={"name": "ts", "root": str(client.root)}).json()
    run = config.PROJECTS_DIR / p["id"] / "runs" / "r1"
    for cid, scale in (("R1/caseA", 1.0), ("R2/caseA", 2.0)):
        d = run / cid
        d.mkdir(parents=True)
        (d / "dispersion_timeseries.csv").write_text(
            "time [s],E,a_norm\n" + "".join(f"{t},{scale * t},{'' if t else 'nan'}\n"
                                         for t in range(5)))
        (d / "holdup_profile.csv").write_text("time_s,z_m,phi_mean\n0,0,1\n0,1,1\n")
        (d / "stats_summary.csv").write_text("file,variable\n")
    (run / "R1" / "caseA" / "phase_uniformity.csv").write_text("time_s,cov_10x3\n0,0.5\n")
    (run / "R1" / "caseA" / "ua.csv").write_text("Time [s],UA [W/K],Momentum steady state [bool]\n0,1.5,False\n1,2.5,True\n")
    # cfd_zoner data: a time trace (series) and the slice tables (not series, nested per variable)
    (run / "R1" / "caseA" / "time_trace.csv").write_text("time [s],Mean Velocity [m/s],steady_start_s,analysis_time_s\n0,1,0.5,1\n1,2,,\n")
    z = run / "R1" / "caseA" / "velocity"
    z.mkdir()
    (z / "zone_slices.csv").write_text("view,title,u_label,v_label,u0 [m],du [m],nu [count],v0 [m],dv [m],nv [count],plane_coordinate [m],variable,unit\n"
                                     "side,side view,x [m],y [m],0,0.1,2,0,0.1,1,0,Velocity Magnitude (m/s),m/s\n")
    (z / "zone_slice_side.csv").write_text("y \\ x [m],0,0.1\n0,1,2\n")
    (z / "profiles.csv").write_text("profile,coordinate [m],v,cells [count]\naxial (y),0,1,3\n")
    base = f"/api/projects/{p['id']}/runs/r1"
    files = {f["file"]: f for f in client.get(f"{base}/timeseries").json()}
    assert set(files) == {"dispersion_timeseries.csv", "phase_uniformity.csv", "ua.csv", "time_trace.csv"}
    runs = {r["name"]: r for r in client.get(f"/api/projects/{p['id']}/runs").json()}
    assert {"R1/caseA/velocity/zone_slices.csv", "R1/caseA/velocity/zone_slice_side.csv"} <= set(runs["r1"]["csvs"])
    s = client.get(f"{base}/series", params={"file": "ua.csv", "columns": ["UA [W/K]"], "cases": ["R1/caseA"]}).json()
    assert s["R1/caseA"] == {"t": [0, 1], "columns": {"UA [W/K]": [1.5, 2.5]}}
    assert files["dispersion_timeseries.csv"]["cases"] == ["R1/caseA", "R2/caseA"]
    assert files["dispersion_timeseries.csv"]["columns"] == ["E", "a_norm"]
    s = client.get(f"{base}/series", params={"file": "dispersion_timeseries.csv",
                                             "columns": ["E", "a_norm", "missing"]}).json()
    assert s["R2/caseA"]["t"] == [0, 1, 2, 3, 4]
    assert s["R2/caseA"]["columns"]["E"] == [0, 2, 4, 6, 8]
    assert s["R1/caseA"]["columns"]["a_norm"] == [None] * 5
    assert "missing" not in s["R1/caseA"]["columns"]
    s = client.get(f"{base}/series", params={"file": "dispersion_timeseries.csv",
                                             "columns": ["E"], "cases": ["R2/caseA"],
                                             "max_points": 2}).json()
    assert list(s) == ["R2/caseA"] and s["R2/caseA"]["t"] == [0, 1, 2, 4]  # bucket extremes kept
    assert client.get(f"{base}/series", params={"file": "../../jobs.db",
                                                "columns": ["E"]}).status_code == 422


def test_run_timeseries_single_case(client):
    p = client.post("/api/projects", json={"name": "one", "root": str(client.root / "R1" / "caseA")}).json()
    assert p["single"]
    cid = p["cases"][0]["id"]
    runs = config.PROJECTS_DIR / p["id"] / "runs"
    (runs / "ua" / cid).mkdir(parents=True)  # per-case task (calc_ua) -> <run>/<case id>/
    (runs / "ua" / cid / "ua.csv").write_text("Time [s],UA [W/K]\n0,1\n1,2\n")
    (runs / "ss").mkdir()  # stats_summary single case -> <run>/
    (runs / "ss" / "dispersion_timeseries.csv").write_text("time [s],E\n0,1\n")
    for run, f in (("ua", "ua.csv"), ("ss", "dispersion_timeseries.csv")):
        base = f"/api/projects/{p['id']}/runs/{run}"
        files = client.get(f"{base}/timeseries").json()
        assert [x["file"] for x in files] == [f] and files[0]["cases"] == [cid]
    s = client.get(f"/api/projects/{p['id']}/runs/ua/series",
                   params={"file": "ua.csv", "columns": ["UA [W/K]"]}).json()
    assert s[cid]["columns"]["UA [W/K]"] == [1, 2]

def test_job_rerun_and_delete(client):
    p = client.post("/api/projects", json={"name": "rr", "root": str(client.root)}).json()
    j = client.post(f"/api/projects/{p['id']}/run",
                    json={"task": "stats_summary", "params": {"time": 1.5}}).json()
    assert j["user"] == "tester"  # the logged-in account
    j = wait(client, j["id"])
    assert j["status"] == "done"
    run = Path(j["run_dir"])
    assert json.loads((run / "job.json").read_text())["user"] == "tester"
    assert client.get(f"/api/projects/{p['id']}/runs").json()[0]["user"] == "tester"
    marker = run / "stale.txt"
    marker.write_text("old")
    logout(client)
    login(client, "bob")  # neither the job's user nor the project owner
    assert client.post(f"/api/jobs/{j['id']}/rerun").status_code == 403
    assert client.delete(f"/api/jobs/{j['id']}").status_code == 403
    logout(client)
    login(client, auth.server_account())  # admin
    j2 = client.post(f"/api/jobs/{j['id']}/rerun").json()
    assert j2["id"] == j["id"] and j2["status"] in ("queued", "running") and j2["user"] == auth.server_account()
    assert not marker.exists()
    j2 = wait(client, j["id"])
    assert j2["status"] == "done" and (run / "batch_summary.csv").is_file()
    assert client.delete(f"/api/jobs/{j['id']}").json() == {"deleted": j["id"]}
    assert not run.exists()
    assert client.get(f"/api/jobs/{j['id']}").status_code == 404


def test_relocate_after_rename(client, monkeypatch):
    p = client.post("/api/projects", json={"name": "mv", "root": str(client.root)}).json()
    url = f"/api/projects/{p['id']}"
    (client.root / "R2").rename(client.root / "R2b")
    g = client.get(url).json()
    assert not g["root_missing"]
    assert [c["id"] for c in g["cases"] if c["missing"]] == ["R2/caseA"]
    assert client.post(f"{url}/relocate", json={"cases": {"R2/caseA": str(client.root / "R1")}}).status_code == 422
    r = client.post(f"{url}/relocate", json={"cases": {"R2/caseA": str(client.root / "R2b" / "caseA")}}).json()
    c = next(c for c in r["cases"] if c["id"] == "R2/caseA")
    assert not c["missing"] and c["path"] == str(client.root / "R2b" / "caseA")
    moved = client.root.parent / "data_new"
    client.root.rename(moved)
    monkeypatch.setattr(config, "ROOTS", [client.root.parent])
    g = client.get(url).json()
    assert g["root_missing"] and all(c["missing"] for c in g["cases"])
    r = client.post(f"{url}/relocate", json={"root": str(moved)}).json()
    assert not r["root_missing"] and not any(c["missing"] for c in r["cases"])
    assert [c["id"] for c in r["cases"]] == [c["id"] for c in g["cases"]]


def test_case_aliases(client):
    p = client.post("/api/projects", json={"name": "al", "root": str(client.root)}).json()
    url = f"/api/projects/{p['id']}"
    r = client.patch(url, json={"aliases": {"R1/caseA": " A1 ", "R2/caseA": "", "nope": "x"}})
    assert r.json()["aliases"] == {"R1/caseA": "A1"}
    assert client.get(url).json()["aliases"] == {"R1/caseA": "A1"}
    assert client.patch(url, json={"aliases": {"R1/caseA": "R2/caseA"}}).status_code == 422
    assert client.patch(url, json={"aliases": {}}).json()["aliases"] == {}


def test_job_labels_unique_and_rename(client):
    p = client.post("/api/projects", json={"name": "lb", "root": str(client.root)}).json()
    body = {"task": "stats_summary", "cases": ["R2/caseA"],
            "params": {"time": 1.5, "canon_body": False}}
    j1 = client.post(f"/api/projects/{p['id']}/run", json=body).json()
    j2 = client.post(f"/api/projects/{p['id']}/run", json=body).json()
    assert j1["label"] == "M-Star Stats summary, 1 case"
    assert j2["label"] == j1["label"] + " #2"
    wait(client, j1["id"]), wait(client, j2["id"])
    r = client.patch(f"/api/jobs/{j2['id']}", json={"label": " low rpm "})
    assert r.json()["label"] == "low rpm"
    assert json.loads((Path(j2["run_dir"]) / "job.json").read_text())["label"] == "low rpm"
    runs = client.get(f"/api/projects/{p['id']}/runs").json()
    assert "low rpm" in [x["label"] for x in runs]
    assert client.patch(f"/api/jobs/{j1['id']}", json={"label": "low rpm"}).status_code == 409
    assert client.patch(f"/api/jobs/{j1['id']}", json={"label": "  "}).status_code == 422


def test_custom_script_and_cancel(client, tmp_path):
    script = client.root / "tool.py"
    script.write_text("import sys, pathlib, time\n"
                      "pathlib.Path(sys.argv[2], 'out.txt').write_text(sys.argv[1])\n"
                      "time.sleep(float(sys.argv[3]))\n")
    p = client.post("/api/projects", json={"name": "c", "root": str(client.root)}).json()
    j = client.post(f"/api/projects/{p['id']}/run", json={
        "task": "custom_script", "cases": ["R2/caseA"],
        "params": {"script": str(script), "args": "{case_id} {out} 0"}}).json()
    j = wait(client, j["id"])
    assert j["status"] == "done"
    assert (Path(j["run_dir"]) / "R2" / "caseA" / "out.txt").read_text() == "R2/caseA"

    j = client.post(f"/api/projects/{p['id']}/run", json={
        "task": "custom_script", "cases": ["R2/caseA"],
        "params": {"script": str(script), "args": "{case_id} {out} 60"}}).json()
    time.sleep(1.0)
    assert client.delete(f"/api/jobs/{j['id']}").status_code == 409
    assert client.post(f"/api/jobs/{j['id']}/rerun").status_code == 409
    client.post(f"/api/jobs/{j['id']}/cancel")
    assert wait(client, j["id"], 20)["status"] == "cancelled"
    bad = client.post(f"/api/projects/{p['id']}/run", json={
        "task": "custom_script", "params": {"script": "/etc/passwd"}})
    assert bad.status_code == 403


_LOG_HEAD = ("Export directory: /x\nStarted process with PID = {pid}\nM-Star CFD (4.5.47)\n"
             'Process 0 | Running on GPU "NVIDIA RTX 6000 Ada Generation" with UUID abc-1\n\n')
_LOG_BLOCK = ("--------------------------------------------------\nTime (s) = {t}\nIterations = {it}\n\n"
              "Performance:\nLattice (MUPS) = 424.8\n\nProgress:\nTime (s) = {t}\nCompletion (%) = {pct}\n"
              "Runtime (s) = 100\nElapsed Wall Time (hr) = 15.24\nEstimated Time Remaining (hr) = {eta}\n"
              "--------------------------------------------------\n\n")


def test_solver_status(client, tmp_path):
    from app import solver
    case = client.root / "R1" / "caseA"
    assert solver.solve_status(case)["state"] == "no log"
    me = os.getpid()  # alive, but not an M-Star process
    (case / "mstar-run-2026_10_22_2205.txt").write_text(
        _LOG_HEAD.format(pid=me) + _LOG_BLOCK.format(t=50, it=1000, pct=50, eta=15.2))
    s = solver.solve_status(case)
    assert s["state"] == "failed" and s["pid"] == me and s["completion_pct"] == 50 and s["time_s"] == 50 \
        and s["runtime_s"] == 100 and s["iterations"] == 1000 and s["gpu"].startswith("NVIDIA") and s["version"] == "4.5.47"
    with monkeypatch_alive(solver, True):
        assert solver.solve_status(case)["state"] == "running"
        assert solver.solve_status(case, now=time.time() + 3600)["state"] == "stalled"
    # a newer log (later start time in the name) wins; its end marker decides
    newer = case / "mstar-run-2026_10_23_0900.txt"
    newer.write_text(_LOG_HEAD.format(pid=1) + _LOG_BLOCK.format(t=100, it=2000, pct=100, eta=-0)
                     + "Writing checkpoint at time 100\nDone writing checkpoint\n\n\nSimulation Complete\n")
    s = solver.solve_status(case)
    assert s["state"] == "complete" and s["log"] == newer.name and s["n_logs"] == 2 and s["last_lines"][-1] == "Simulation Complete"
    newer.write_text(_LOG_HEAD.format(pid=1) + "Found command to stop simulation\n\nSimulation Stopped\n")
    assert solver.solve_status(case)["state"] == "stopped"
    p = client.post("/api/projects", json={"name": "s", "root": str(client.root)}).json()
    r = client.get(f"/api/projects/{p['id']}/solves").json()
    assert r["R1/caseA"]["state"] == "stopped" and r["R2/caseA"]["state"] == "no log"


class monkeypatch_alive:
    def __init__(self, mod, value):
        self.mod, self.value = mod, value
    def __enter__(self):
        self.old = self.mod.pid_alive
        self.mod.pid_alive = lambda pid: self.value
    def __exit__(self, *a):
        self.mod.pid_alive = self.old
