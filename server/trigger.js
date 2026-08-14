import { runDailyBlessing } from "../agent/daily-agent.js";

let running = false;

// Hit daily by the Edge job. Runs the agent in-process; the result lands on
// the blessings volume so it is served immediately.
export async function triggerHandler(req, res) {
  const token = process.env.TRIGGER_TOKEN;
  if (!token) {
    return res
      .status(503)
      .json({ ok: false, reason: "TRIGGER_TOKEN not configured" });
  }
  const authorized =
    req.get("authorization") === `Bearer ${token}` ||
    req.get("x-api-key") === token;
  if (!authorized) {
    return res.status(401).json({ ok: false, reason: "bad token" });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res
      .status(200)
      .json({ ok: false, reason: "OPENAI_API_KEY not set" });
  }
  if (running)
    return res.status(200).json({ ok: false, reason: "already running" });

  running = true;
  try {
    const blessed = await runDailyBlessing();
    res.json({ ok: true, blessed });
  } catch (err) {
    console.error("blessing failed:", err);
    res.status(200).json({ ok: false, reason: err.message });
  } finally {
    running = false;
  }
}
