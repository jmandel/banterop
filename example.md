import { useState } from "react";

// --- Minimal UI primitives ---
function Badge({ children, tone = "slate" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-emerald-100 text-emerald-700",
    blue: "bg-blue-100 text-blue-700",
    amber: "bg-amber-100 text-amber-700",
    red: "bg-rose-100 text-rose-700",
    gray: "bg-gray-100 text-gray-700",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
  );
}

function Button({ children, variant = "solid", tone = "slate", ...props }) {
  const base = "inline-flex items-center justify-center rounded-xl px-3 py-2 text-sm font-medium shadow-sm transition active:translate-y-px";
  const tones = {
    slate: {
      solid: "bg-slate-900 text-white hover:bg-slate-800",
      outline: "border border-slate-300 text-slate-700 hover:bg-slate-50",
      ghost: "text-slate-700 hover:bg-slate-100",
    },
    blue: {
      solid: "bg-blue-600 text-white hover:bg-blue-500",
      outline: "border border-blue-300 text-blue-700 hover:bg-blue-50",
      ghost: "text-blue-700 hover:bg-blue-100",
    },
    red: {
      solid: "bg-rose-600 text-white hover:bg-rose-500",
      outline: "border border-rose-300 text-rose-700 hover:bg-rose-50",
      ghost: "text-rose-700 hover:bg-rose-100",
    },
    green: {
      solid: "bg-emerald-600 text-white hover:bg-emerald-500",
      outline: "border border-emerald-300 text-emerald-700 hover:bg-emerald-50",
      ghost: "text-emerald-700 hover:bg-emerald-100",
    },
  };
  return (
    <button className={`${base} ${tones[tone][variant]}`} {...props}>
      {children}
    </button>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center justify-between gap-3 py-1">
      <span className="text-sm text-slate-700">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`h-6 w-11 rounded-full p-0.5 transition ${checked ? "bg-emerald-500" : "bg-slate-300"}`}
        aria-pressed={checked}
      >
        <span className={`block h-5 w-5 rounded-full bg-white transition ${checked ? "translate-x-5" : "translate-x-0"}`} />
      </button>
    </label>
  );
}

// --- Conversation message bubble ---
function Bubble({ role, time, children }) {
  const isClient = role === "Client";
  return (
    <div className={`flex ${isClient ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-3xl rounded-2xl border shadow-sm ${isClient ? "bg-white" : "bg-blue-50 border-blue-100"}`}>
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <Badge tone={isClient ? "slate" : "blue"}>{role}</Badge>
          <span className="text-xs text-slate-500">{time}</span>
        </div>
        <div className="prose prose-sm max-w-none px-4 py-3 text-slate-800">{children}</div>
      </div>
    </div>
  );
}

function Modal({ open, onClose, children, title }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg rounded-2xl border bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700">✕</button>
        </div>
        <div className="p-4">{children}</div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button tone="blue" onClick={onClose}>Save</Button>
        </div>
      </div>
    </div>
  );
}

// --- Page ---
export default function ConversationConsole() {
  // Automation state
  const [requireReview, setRequireReview] = useState(true);
  const [planner, setPlanner] = useState("LLM Drafter");

  // Settings state
  const [showSettings, setShowSettings] = useState(false);
  const [model, setModel] = useState("gpt-4o");
  const [scenario, setScenario] = useState("Sample: Onboarding Walkthrough");
  const [scenarioURL, setScenarioURL] = useState("");

  // Demo conversation history
  const [turns] = useState([
    {
      id: 1,
      role: "Client",
      time: "10:14 AM",
      content: (
        <>
          <p>Dear [Recipient],</p>
          <p>
            I hope you’re doing well. I’m writing to follow up on our recent discussion regarding the project timeline and deliverables. Could you please share the latest updates on the milestones we outlined, as well as any outstanding items that need my attention?
          </p>
          <p>Thank you for your assistance. I look forward to your response.</p>
          <p>Best regards,<br/>[Your Name]</p>
        </>
      ),
    },
    {
      id: 2,
      role: "Agent",
      time: "10:15 AM",
      content: (
        <>
          <p>Dear [Your Name],</p>
          <p>
            Thanks for your note. Here is the latest on milestones and what we need from you next.
          </p>
          <h4>Milestones</h4>
          <ul>
            <li><strong>Requirements</strong>: Completed Apr 22; doc uploaded to drive.</li>
            <li><strong>Design</strong>: Wireframes delivered May 3; hi‑fi mockups due May 15.</li>
            <li><strong>Dev Sprint 1</strong>: 60% complete; unit tests passing.</li>
          </ul>
          <h4>Your Actions</h4>
          <ul>
            <li>Approve May 3 wireframes.</li>
            <li>Provide staging API keys by May 12.</li>
            <li>Choose onboarding approach (A or B) before May 18.</li>
          </ul>
          <p>Best regards,<br/>Team</p>
        </>
      ),
    },
  ]);

  // Demo log entries (long to force scrollbar)
  const logItems = Array.from({ length: 24 }).map((_, i) => (
    i === 0
      ? { t: "10:16:03", msg: "Policy check passed; awaiting review", tag: "info" }
      : i === 1
      ? { t: "10:15:42", msg: "Draft prepared by planner LLM Drafter", tag: "draft" }
      : i === 2
      ? { t: "10:15:12", msg: "Tools queried: milestones.store, schedule.get", tag: "tools" }
      : i === 3
      ? { t: "10:14:55", msg: "Client turn received (length 428 chars)", tag: "incoming" }
      : { t: `10:${14 - Math.floor(i / 2)}:${(60 - (i * 3)) % 60}`.padEnd(8, "0"), msg: `Trace event ${i}`, tag: "trace" }
  ));

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header with Room + integrated Task status */}
      <header className="sticky top-0 z-20 border-b bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <span className="text-xs text-slate-500">Room</span>
          <span className="font-semibold text-slate-900">abc</span>
          <Badge tone="green">Connected</Badge>

          <div className="ml-4 hidden h-6 w-px bg-slate-200 sm:block" />

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span className="hidden sm:inline">Task</span>
            <span className="font-medium">resp:abc#19</span>
            <Badge tone="amber">Your turn</Badge>
            <span>Waiting for review</span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" onClick={() => setShowSettings(true)}>⚙️ Settings</Button>
          </div>
        </div>
      </header>

      {/* Two-column layout */}
      <main className="mx-auto grid max-w-7xl grid-cols-1 gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* Left: Conversation (full history) */}
        <section className="space-y-4">
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-semibold text-slate-800">Conversation</h3>
            <div className="space-y-3">
              {turns.map((t) => (
                <Bubble key={t.id} role={t.role} time={t.time}>{t.content}</Bubble>
              ))}
            </div>
          </div>
        </section>

        {/* Right: Links + Automation + Log */}
        <aside className="space-y-4">
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-800">Links</h3>
            <div className="mt-2 space-y-2 text-sm text-slate-700">
              <div className="flex items-center justify-between"><span>Agent card</span><Button variant="outline">Copy</Button></div>
              <div className="flex items-center justify-between"><span>MCP URL</span><Button variant="outline">Copy</Button></div>
              <div className="flex items-center justify-between"><span>Open Sample Client</span><Button tone="blue">Launch</Button></div>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-800">Automation</h3>
            <div className="mt-3 space-y-2">
              <Toggle label="Require review before sending" checked={requireReview} onChange={setRequireReview} />
              <div>
                <label className="text-xs text-slate-500">Planner</label>
                <select
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-2 py-2 text-sm shadow-sm"
                  value={planner}
                  onChange={(e) => setPlanner(e.target.value)}
                >
                  <option>LLM Drafter</option>
                  <option>Tool‑first</option>
                  <option>Cost‑saver</option>
                </select>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-800">Log</h3>
            <div className="mt-2 h-64 overflow-y-auto rounded-xl border bg-slate-50 p-2">
              <ul className="space-y-1 text-xs text-slate-700">
                {logItems.map((li, idx) => (
                  <li key={idx} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-white">
                    <span className="font-mono text-[11px] text-slate-500">{li.t}</span>
                    <span className="flex-1 truncate px-2">{li.msg}</span>
                    <Badge tone={li.tag === "incoming" ? "slate" : li.tag === "draft" ? "blue" : li.tag === "info" ? "green" : "gray"}>{li.tag}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </aside>
      </main>

      {/* Settings modal */}
      <Modal open={showSettings} onClose={() => setShowSettings(false)} title="Console Settings">
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="text-xs text-slate-500">Preferred language model</label>
            <select
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-2 py-2 text-sm shadow-sm"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="gpt-5">GPT‑5</option>
              <option value="gpt-4.1">GPT‑4.1</option>
              <option value="gpt-4o">GPT‑4o</option>
              <option value="o3-mini">o3‑mini</option>
            </select>
          </div>

          <div>
            <label className="text-xs text-slate-500">Scenario</label>
            <select
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-2 py-2 text-sm shadow-sm"
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
            >
              <option>Sample: Onboarding Walkthrough</option>
              <option>Sample: Milestone Update</option>
              <option>Sample: SEV / Incident</option>
              <option>Custom (paste URL below)</option>
            </select>
            <input
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm"
              placeholder="Paste scenario URL (optional)"
              value={scenarioURL}
              onChange={(e) => setScenarioURL(e.target.value)}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

