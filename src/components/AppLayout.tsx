import { Outlet } from "react-router-dom";

export default function AppLayout() {
  return (
    <div>
      <header className="app-header">
        <a href="/" className="brand jp">
          日本語 <small>học qua video</small>
        </a>
        <div className="search">
          <span aria-hidden>🔍</span>
          <input placeholder="Tìm series…" />
        </div>
        <a className="btn btn-sm" href="/admin">
          Admin
        </a>
      </header>
      <Outlet />
    </div>
  );
}
