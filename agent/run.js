// Entry point for the Edge execute cronjob: unconditionally runs one blessing.
// (The argv-based CLI detection in daily-agent.js is unreliable under edgejs.)
import { runDailyBlessing } from "./daily-agent.js";

runDailyBlessing()
  .then((entry) => {
    console.log("exec-job blessed:", entry.id);
    process.exit(0);
  })
  .catch((err) => {
    console.error("exec-job failed:", err);
    process.exit(1);
  });
