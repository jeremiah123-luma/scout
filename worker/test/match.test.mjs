// node --test worker/test
// The student-side matching (src/match.js). The verdict cases come from the Python rules (fixtures/verdicts.json,
// written by scout/eligibility.py over the page lines quoted in tests/), so the two can't drift apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verdict, profileFrom, yearFromGrad, standingMinYear, exclusion, score, rank, isOpen, inUS, isQuiet, hourOf, digestDue, instantPicks, localNow } from "../src/match.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/verdicts.json", import.meta.url), "utf8"));

test("the JS verdict matches the Python verdict on every real page line", () => {
  for (const c of cases) {
    const p = { gradYear: c.profile.graduation_year, yearInSchool: c.profile.year_in_school, degree: (c.profile.degree || "bachelor's").toLowerCase(),
      enrolled: c.profile.enrolled !== false, pastInternship: !!c.profile.past_internship, cycleYear: 2027 };
    assert.deepEqual(verdict(c.facts, p), c.expect, JSON.stringify({ facts: c.facts, profile: c.profile }));
  }
  assert.ok(cases.length > 400);
});

test("profile from answers", () => {
  const oct = new Date(2026, 9, 21);
  const p = profileFrom({ grad: "May 2029", year: "second", degree: "bachelor's", experience: "Summer intern at Acme" }, oct);
  assert.equal(p.gradYear, 2029); assert.equal(p.yearInSchool, 2); assert.equal(p.pastInternship, true); assert.equal(p.cycleYear, 2027);
  assert.equal(profileFrom({ grad: "May 2030" }, oct).yearInSchool, 1);
  assert.equal(profileFrom({ year: "recent grad" }, oct).enrolled, false);
  assert.equal(yearFromGrad(2030, new Date(2027, 8, 1)), 2);
  assert.equal(standingMinYear("At least a sophomore at time of application"), 2);
  assert.equal(standingMinYear("Completed sophomore year of college"), 3);
});

test("US check reads real location strings", () => {
  for (const l of ["New York, NY", "NYC", "Remote in USA", "Remote in USA or Canada", "Multiple Locations, United States", "SF", "Remote",
    "Charlotte, NC", "Raleigh, North Carolina", "Chicago, IL", "Indianapolis, IN", "Wilmington, DE", "San Jose, CA", "Mountain View, CA"]) assert.ok(inUS({ locations: [l] }), l);
  for (const l of ["London, UK", "Toronto, ON, CAN", "Bengaluru, India", "Mexico City, MX", "Amsterdam, NL", "Seoul, KR", "Vancouver, BC",
    "Remote in Europe", "Montreal, QC"]) assert.ok(!inUS({ locations: [l] }), l);
  assert.ok(inUS({ locations: ["London, UK", "Seattle, WA"] }), "any US location keeps it");
  assert.ok(inUS({ locations: [] }), "no location listed stays");
});

test("their hard answers leave postings out", () => {
  const p = profileFrom({});
  assert.equal(exclusion({ locations: ["London, UK"] }, {}, p), "outside the US");
  assert.equal(exclusion({ locations: ["London, UK"] }, { abroad: "yes" }, p), "");
  assert.equal(exclusion({ citizens_only: true }, { citizen: "no" }, p), "US citizens only");
  assert.equal(exclusion({ sponsorship: "Does Not Offer Sponsorship" }, { sponsorship: "yes, later" }, p), "no visa sponsorship");
  assert.equal(exclusion({ title: "Sales Engineering Intern" }, { never_words: ["sales"] }, p), 'has "sales"');
  assert.equal(exclusion({ company: "Acme Inc." }, { never_companies: ["acme"] }, p), "a company you hid");
});

test("scores follow the student, not the owner", () => {
  const now = Date.UTC(2026, 9, 21);
  const m = { company: "Figma", title: "Product Design Intern", role: "design", tier: 2, locations: ["San Francisco, CA"], latest_posted: now / 1000 - 3600 };
  const designer = { fields: ["UX/UI and product design"], top_field: "UX/UI and product design", dream: ["Figma"], places: ["san francisco"] };
  const coder = { fields: ["software engineering"] };
  const a = score(m, designer, profileFrom(designer), now), b = score(m, coder, profileFrom(coder), now);
  assert.ok(a.score > b.score + 30, `${a.score} vs ${b.score}`);
  assert.ok(a.score <= 100 && b.score >= 0);
});

test("scoring is fast enough for the free CPU limit", () => {
  const m = Array.from({ length: 300 }, (_, i) => ({ key: "k" + i, company: "Company " + (i % 40), title: "Software Engineer Intern", role: "swe", locations: ["New York, NY"], latest_posted: 1.79e9 }));
  const heavy = { fields: ["software engineering"], dream: Array.from({ length: 10 }, (_, i) => "Dream " + i), excited: Array.from({ length: 10 }, (_, i) => "Excited " + i),
    never_companies: Array.from({ length: 10 }, (_, i) => "Hidden " + i), places: ["nyc", "new jersey"], roles: ["front end", "ios"], skills: ["python", "swift"] };
  for (let i = 0; i < 30; i++) rank(m, heavy);
  const t0 = performance.now(); for (let i = 0; i < 100; i++) rank(m, heavy);
  assert.ok((performance.now() - t0) / 100 < 1.5, "ms per student: " + ((performance.now() - t0) / 100).toFixed(2));
});

test("rank marks verdicts and keeps the open ones first by score", () => {
  const ms = [
    { key: "a", company: "X", title: "SWE Intern", role: "swe", locations: ["NYC"], posting_facts: { grad_ranges: [[2028, 2028]] } },
    { key: "b", company: "Y", title: "SWE Intern", role: "swe", locations: ["NYC"], posting_facts: { underclass: true }, early_career: "strong" },
    { key: "c", company: "Z", title: "SWE Intern", role: "swe", eligibility: "closed" },
  ];
  const r = rank(ms, { fields: ["software engineering"], grad: "May 2030", year: "first" });
  const by = Object.fromEntries(r.map((m) => [m.key, m]));
  assert.equal(by.a.my.eligibility, "ineligible"); assert.equal(by.b.my.eligibility, "ok"); assert.equal(by.c.my.eligibility, "closed");
  assert.deepEqual(r.filter(isOpen).map((m) => m.key), ["b"]);
});

test("only postings in their fields, plus programs if they asked", () => {
  const ms = [{ key: "swe", role: "swe" }, { key: "pm", role: "pm" }, { key: "prog", role: "program" }];
  assert.deepEqual(rank(ms, { fields: ["software engineering"] }).map((m) => m.key).sort(), ["swe"]);
  assert.deepEqual(rank(ms, { fields: ["software engineering"], early: ["fellowships"] }).map((m) => m.key).sort(), ["prog", "swe"]);
  assert.equal(rank(ms, {}).length, 3, "no fields picked yet: show everything");
});

test("alert timing", () => {
  assert.equal(hourOf("7:00 PM"), 19); assert.equal(hourOf("12:00 PM"), 12); assert.equal(hourOf("12:00 AM"), 0); assert.equal(hourOf("junk"), 19);
  assert.ok(isQuiet("10:00 PM to 7:00 AM", 23)); assert.ok(isQuiet("10:00 PM to 7:00 AM", 3)); assert.ok(!isQuiet("10:00 PM to 7:00 AM", 12));
  assert.ok(isQuiet("during class (9:00 AM to 3:00 PM)", 10)); assert.ok(!isQuiet("no quiet hours", 3));
  const at7pmNY = new Date(Date.UTC(2026, 9, 21, 23, 0)); // 7 PM in New York (EDT), a Wednesday
  assert.equal(localNow("Eastern (New York)", at7pmNY).hour, 19);
  assert.ok(digestDue({ speed: "once a day", digest_time: "7:00 PM", timezone: "Eastern (New York)" }, "2026-10-20", at7pmNY));
  assert.ok(!digestDue({ speed: "once a day", digest_time: "7:00 PM", timezone: "Eastern (New York)" }, "2026-10-21", at7pmNY), "once a day");
  assert.ok(digestDue({ speed: "once a day", digest_time: "6:00 PM", timezone: "Eastern (New York)" }, "2026-10-20", at7pmNY), "late is still today");
  assert.ok(!digestDue({ speed: "once a day", digest_time: "8:00 PM", timezone: "Eastern (New York)" }, "2026-10-20", at7pmNY), "not before the hour");
  assert.ok(!digestDue({ speed: "once a week", digest_time: "7:00 PM", timezone: "Eastern (New York)" }, "", at7pmNY), "weekly is Mondays");
  assert.ok(!digestDue({ speed: "tell me right away" }, "", at7pmNY));
});

test("instant picks respect their rule and never repeat", () => {
  const since = Date.UTC(2026, 9, 21, 0);
  const ranked = [
    { key: "dream", company: "Apple", arrived: "2026-10-21T01:00:00Z", my: { score: 40, eligibility: "unknown", out: "" } },
    { key: "high", company: "Acme", arrived: "2026-10-21T01:00:00Z", my: { score: 80, eligibility: "unknown", out: "" } },
    { key: "old", company: "Acme", arrived: "2026-10-19T01:00:00Z", my: { score: 90, eligibility: "unknown", out: "" } },
    { key: "out", company: "Acme", arrived: "2026-10-21T01:00:00Z", my: { score: 90, eligibility: "ineligible", out: "" } },
    { key: "nostamp", company: "Acme", first_seen: "", latest_posted: since / 1000 + 600, my: { score: 85, eligibility: "unknown", out: "" } },
  ];
  assert.deepEqual(instantPicks(ranked, { speed: "tell me right away", dream: ["Apple"], strong: "dream companies only" }, new Set(), since).map((m) => m.key), ["dream"]);
  assert.deepEqual(instantPicks(ranked, { speed: "tell me right away" }, new Set(), since).map((m) => m.key), ["high", "nostamp"]);
  assert.deepEqual(instantPicks(ranked, { speed: "tell me right away" }, new Set(["high", "nostamp"]), since), []);
  assert.deepEqual(instantPicks(ranked, { speed: "once a day" }, new Set(), since), []);
});
