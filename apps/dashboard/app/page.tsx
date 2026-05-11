import { PACKAGE_NAME, VERSION } from "../lib/version";

export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>IssuePilot Dashboard</h1>
      <p>
        {PACKAGE_NAME} placeholder — Phase 1 skeleton. Real Service header,
        Summary cards, Runs table and SSE timeline land in Phase 7.
      </p>
      <p>version: {VERSION}</p>
    </main>
  );
}
