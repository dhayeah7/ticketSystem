import { useCallback, useEffect, useState } from "react";
import { TeamPage } from "./components/TeamPage";
import { AssignPage } from "./components/AssignPage";

type View = "team" | "assign";

/** Reads a URL query param, keeping React state in sync with back/forward nav. */
function useUrlParam(key: string, fallback = ""): [string, (v: string) => void] {
  const read = useCallback(
    () => new URLSearchParams(window.location.search).get(key) ?? fallback,
    [key, fallback]
  );
  const [value, setValue] = useState(read);

  useEffect(() => {
    const onPop = () => setValue(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [read]);

  const update = useCallback(
    (v: string) => {
      const url = new URL(window.location.href);
      if (v) url.searchParams.set(key, v);
      else url.searchParams.delete(key);
      window.history.replaceState({}, "", url);
      setValue(v);
    },
    [key]
  );

  return [value, update];
}

export default function App() {
  const [company, setCompany] = useUrlParam("company");
  const [viewParam, setView] = useUrlParam("view", "team");
  const view: View = viewParam === "assign" ? "assign" : "team";
  const [draft, setDraft] = useState(company);

  useEffect(() => setDraft(company), [company]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Ticket System</h1>
        <form
          className="company-form"
          onSubmit={(e) => {
            e.preventDefault();
            setCompany(draft.trim());
          }}
        >
          <label htmlFor="company">Company</label>
          <input
            id="company"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. acme"
          />
          <button type="submit">Open</button>
        </form>
      </header>

      {company ? (
        <>
          <nav className="tabs">
            <button
              className={`tab ${view === "team" ? "active" : ""}`}
              onClick={() => setView("team")}
              type="button"
            >
              Team
            </button>
            <button
              className={`tab ${view === "assign" ? "active" : ""}`}
              onClick={() => setView("assign")}
              type="button"
            >
              Assign tickets
            </button>
          </nav>

          {view === "team" ? (
            // key={company} ties page state to the company: switching companies
            // remounts, so an open edit modal can't outlive its company context
            // and save an agent from the previous company.
            <TeamPage key={company} companyId={company} />
          ) : (
            <AssignPage key={company} companyId={company} />
          )}
        </>
      ) : (
        <p className="hint">
          Enter a company id above to get started. A company exists as soon as
          you add an agent under it.
        </p>
      )}
    </div>
  );
}
