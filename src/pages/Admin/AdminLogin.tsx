import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { adminApi, setToken } from "../../api/client";

export default function AdminLogin() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { token } = await adminApi.login(password);
      setToken(token);
      navigate("/admin/series");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" style={{ background: "var(--bg)" }}>
      <form className="modal" style={{ maxWidth: 380 }} onSubmit={submit}>
        <h2 className="jp">日本語 · Admin</h2>
        <div className="field">
          <label>Mật khẩu quản trị</label>
          <input
            className="input"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <div style={{ color: "#ff9aa6", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <button className="btn btn-primary" style={{ width: "100%" }} disabled={busy || !password}>
          {busy ? "Đang vào…" : "Đăng nhập"}
        </button>
      </form>
    </div>
  );
}
