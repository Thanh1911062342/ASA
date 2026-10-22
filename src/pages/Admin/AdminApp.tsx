import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";

import { getToken, setToken } from "../../api/client";

export default function AdminApp() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) navigate("/admin/login", { replace: true });
    else setReady(true);
  }, [navigate]);

  if (!ready) return null;

  return (
    <div className="admin-shell">
      <nav className="admin-nav">
        <div className="brand" style={{ fontSize: 16, padding: "0 10px 14px" }}>
          <Link to="/">日本語</Link>
          <div className="faint" style={{ fontSize: 11, fontWeight: 400, marginTop: 2 }}>
            trang quản trị
          </div>
        </div>
        <NavLink to="/admin/series" className={({ isActive }) => (isActive ? "on" : "")}>
          Series
        </NavLink>
        <a href="/" target="_blank" rel="noreferrer">
          Xem trang học ↗
        </a>
        <button
          className="btn btn-ghost btn-sm"
          style={{ width: "100%", marginTop: 14, justifyContent: "flex-start" }}
          onClick={() => {
            setToken(null);
            navigate("/admin/login");
          }}
        >
          Đăng xuất
        </button>
      </nav>
      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
