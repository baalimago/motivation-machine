import pg from "pg";

// Wasmer Edge injects DB_HOST / DB_PORT / DB_NAME / DB_USERNAME / DB_PASSWORD.
const configured = !!(process.env.DB_HOST && process.env.DB_NAME);

const pool = configured
  ? new pg.Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_NAME,
      user: process.env.DB_USERNAME ?? process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      // managed pg requires TLS; DB_SSL=off opts out for local setups
      ssl: process.env.DB_SSL === "off" ? false : { rejectUnauthorized: false },
      max: 3,
      connectionTimeoutMillis: 5000,
    })
  : null;

const ID_RE = /^[a-z0-9-]{1,80}$/;

// one view = one render of a blessing (daily pick, gallery click, deep link)
export async function seenHandler(req, res) {
  if (!pool) return res.json({ ok: false, reason: "no database configured" });
  const { id } = req.params;
  if (!ID_RE.test(id))
    return res.status(400).json({ ok: false, reason: "bad id" });
  try {
    const r = await pool.query(
      `
      INSERT INTO blessing_views (id, views) VALUES ($1, 1)
      ON CONFLICT (id) DO UPDATE SET views = blessing_views.views + 1
      RETURNING views
    `,
      [id],
    );
    res.json({ ok: true, views: Number(r.rows[0].views) });
  } catch (err) {
    res.json({ ok: false, reason: err.message });
  }
}

export async function fameHandler(_req, res) {
  if (!pool) return res.json({ ok: true, fame: {} });
  try {
    const r = await pool.query("SELECT id, views FROM blessing_views");
    res.json({
      ok: true,
      fame: Object.fromEntries(r.rows.map((x) => [x.id, Number(x.views)])),
    });
  } catch (err) {
    res.json({ ok: false, reason: err.message, fame: {} });
  }
}

export async function visitHandler(_req, res) {
  if (!pool) return res.json({ ok: false, reason: "no database configured" });
  try {
    const upsert = await pool.query(`
      INSERT INTO visits (day, total) VALUES (CURRENT_DATE, 1)
      ON CONFLICT (day) DO UPDATE SET total = visits.total + 1
      RETURNING total
    `);
    const sum = await pool.query(
      "SELECT COALESCE(SUM(total), 0) AS total FROM visits",
    );
    res.json({
      ok: true,
      today: Number(upsert.rows[0].total),
      total: Number(sum.rows[0].total),
    });
  } catch (err) {
    res.json({ ok: false, reason: err.message });
  }
}
