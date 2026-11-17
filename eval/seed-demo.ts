import { config } from "../src/config.js";
import { openDatabase } from "../src/memory/db.js";
import { seedDemo } from "../src/memory/seed-demo.js";
import { systemClock } from "../src/time/clock.js";

const db = openDatabase(config.DATABASE_PATH);
try {
  console.log(seedDemo(db, systemClock, config.TIME_ZONE) ? "Demo history seeded." : "Database already contains history.");
} finally {
  db.close();
}
