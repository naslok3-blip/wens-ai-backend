import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");

test("Egyptian club fixture searches include current-season official and independent sources", () => {
  assert.ok(worker.includes("egyptClubScheduleQuery"));
  assert.ok(worker.includes("getCurrentEgyptFootballSeason()"));
  assert.ok(worker.includes("hasUpcomingFootballDate(plain)"));
  assert.ok(worker.includes("https://www.alahlyegypt.com/en/news/article/al-ahlys-202627-egyptian-premier-league-first-stage-fixtures-revealed"));
  assert.ok(worker.includes("https://www.goal.com/en-sa/team/al-ahly-sc/fixtures-results/1q2hx9pw8c7x88utqunk4e6xl"));
  assert.ok(worker.includes("https://www.goal.com/en-gh/team/pyramids-fc/fixtures-results/a5hh43fi88rchrm37263600hu"));
  assert.ok(worker.includes("Ahram Online Egyptian Premier League fixtures"));
});

test("Ahly–Pyramids result searches compare the official club report with independent match coverage", () => {
  assert.ok(worker.includes("egyptClubResultQuery"));
  assert.ok(worker.includes("https://www.alahlyegypt.com/en/news/article/al-ahly-lose-2-0-to-pyramids-fc-in-the-egyptian-premier-league"));
  assert.ok(worker.includes("https://english.ahram.org.eg/NewsContentP/6/583167/Sports/Match-facts-Ahly-v-Pyramids-Egyptian-Premier-Leagu.aspx"));
  assert.ok(worker.includes("https://www.sofascore.com/football/match/pyramids-fc-al-ahly-fc/kNcscavb"));
  assert.ok(worker.includes("const hasScore = /(?:0\\s*[-–:]\\s*2|2\\s*[-–:]\\s*0)/i.test(plain)"));
});
