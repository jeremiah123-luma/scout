// Rules for "Let's Add to Your Resume": email parsing by pattern, distance, the 7-day flag, sorting, resume lines.
// Sample emails are made-up text in the shape of the real campus announcements (no real mail is stored in the repo).
import test from "node:test";
import assert from "node:assert/strict";
import { parseHackathonMail } from "../src/mailparse.js";
import { miles, findPlace, daysUntil, decorate, visible, sortEvents, mergeEvents, hackathonLine, certLine } from "../src/resumelogic.js";

const robotics = {
  id: "m1", from: "Dina <danello@njit.edu>", subject: "Robotics Hackathon - Viam x IEEE NJIT", date: "2026-10-27T19:36:43Z",
  text: `To view this email online, paste this link into your browser:
https://t.example.net/message/abc

Robotics Hackathon - Viam x IEEE NJIT

On Friday, November 6, IEEE NJIT is partnering with Viam for a one-day hackathon at their NYC headquarters.

Date: Friday, November 6

Location: Viam Robotics, New York City

Applications close this Friday, October 30, and spots are limited.

REGISTER HERE!!! (https://t.example.net/click/abc/xyz)

Got this as a forward? Sign up (https://app.example.net/app2/audience/signup/1)`,
};

test("a one-event announcement: name, date, deadline, location, link", () => {
  const [e] = parseHackathonMail(robotics);
  assert.equal(e.name, "Robotics Hackathon - Viam x IEEE NJIT");
  assert.equal(e.start, "2026-11-06", "Friday, November 6 is a Friday in 2026");
  assert.equal(e.deadline, "2026-10-30");
  assert.equal(e.location, "Viam Robotics, New York City");
  assert.equal(e.url, "https://t.example.net/click/abc/xyz", "the register link, not the view-online or sign-up plumbing");
  assert.equal(e.travel, null, "nothing said about travel stays blank");
});

test("a date with no year and no weekday is kept as written, never guessed", () => {
  const [e] = parseHackathonMail({ id: "m2", from: "danello@njit.edu", subject: "SBUHacks 2026", date: "2026-10-01T12:00:00Z",
    text: "Join us at Stony Brook on Oct 23-25 for SBUHacks." });
  assert.equal(e.start, null);
  assert.equal(e.date_text, "Oct 23-25");
  assert.equal(e.deadline, null);
});

test("an explicit year is used as is, and a weekday that fits neither year is not guessed", () => {
  const [a] = parseHackathonMail({ id: "m3", from: "danello@njit.edu", subject: "KeanUHackThis", date: "2026-09-30T12:00:00Z",
    text: "Kean University is hosting KeanUHackThis.\n\nDate: April 2, 2027\n\nWhere: Green Lane Academic Building" });
  assert.equal(a.start, "2027-04-02");
  assert.equal(a.host, "Kean University");
  const [b] = parseHackathonMail({ id: "m4", from: "danello@njit.edu", subject: "Some Hackathon", date: "2026-10-01T12:00:00Z", text: "Tuesday, November 6 at the campus center." });
  assert.equal(b.start, null, "Nov 6 is not a Tuesday in 2026 or 2027");
});

test("subject filler is stripped from the name", () => {
  const n = (subject) => parseHackathonMail({ id: "x", from: "ywcc@njit.edu", subject, date: "2026-10-01T00:00:00Z", text: "details" })[0].name;
  assert.equal(n("Register Today for GirlHacks!"), "GirlHacks");
  assert.equal(n("Fwd: UConn-Stamford Hackathon - TOMORROW 10/21"), "UConn-Stamford Hackathon");
  assert.equal(n("Steelhacks 2027!"), "Steelhacks 2027");
});

test("registration closes today, with the weekday that pins the year", () => {
  const [e] = parseHackathonMail({ id: "g", from: "ywcc-advising@njit.edu", subject: "Register Today for GirlHacks!", date: "2026-09-09T14:10:02Z",
    text: "GirlHacks is hosted by NJIT's Women in Computing Society (WiCS).\n\nRegistration closes TODAY, Wednesday, September 9, so sign up." });
  assert.equal(e.deadline, "2026-09-09");
  assert.equal(e.host, "NJIT's Women in Computing Society");
});

test("travel help is only reported when the email says it", () => {
  const [e] = parseHackathonMail({ id: "t", from: "danello@njit.edu", subject: "ExampleHacks", date: "2026-10-01T00:00:00Z",
    text: "Free buses will be provided from campus.\n\nTravel reimbursement up to $50 is available." });
  assert.match(e.travel, /bus|reimburs/i);
});

test("a newsletter gives one event per hackathon paragraph; a non-hackathon mail gives none", () => {
  const news = parseHackathonMail({ id: "n", from: "ywcc@njit.edu", subject: "YWCC October Newsletter", date: "2026-10-01T00:00:00Z",
    text: "Welcome back!\n\nHackNJIT moves to November 21-22, 2026 at the Campus Center.\n\nCareer fair is Tuesday.\n\nBostonHacks is on Nov 21, 2026 in Boston." });
  assert.deepEqual(news.map((e) => e.name), ["HackNJIT", "BostonHacks"]);
  assert.equal(news[0].start, "2026-11-21");
  assert.equal(news[0].end, "2026-11-22");
  assert.deepEqual(parseHackathonMail({ id: "z", from: "ywcc@njit.edu", subject: "Career fair Tuesday", date: "2026-10-01T00:00:00Z", text: "Bring your resume." }), []);
});

test("distance: Newark to Princeton is about 38 miles; known places resolve longest alias first", () => {
  const d = miles(40.7424, -74.1779, 40.3431, -74.6551);
  assert.ok(d > 35 && d < 42, String(d));
  assert.equal(findPlace("UConn Stamford hackathon").name, "UConn Stamford");
  assert.equal(findPlace("somewhere unknown"), null);
});

const home = { lat: 40.7424, lon: -74.1779 };
const today = "2026-10-28";
const ev = (o) => ({ key: o.name, source: "mlh", ...o });

test("the 7-day flag, sorting by soonest deadline, and the chips", () => {
  const list = decorate([
    ev({ name: "Far", start: "2026-12-01", deadline: "2026-11-30", lat: 42.4, lon: -71.1 }),
    ev({ name: "Soon", start: "2026-11-06", deadline: "2026-10-30", lat: 40.74, lon: -74.0 }),
    ev({ name: "Later", start: "2026-11-14", deadline: "2026-11-10", lat: 40.3431, lon: -74.6551, host: "Princeton University" }),
    ev({ name: "No deadline", start: "2026-11-02", lat: 40.7, lon: -74.1 }),
    ev({ name: "Over", start: "2026-10-10", end: "2026-10-11", lat: 40.7, lon: -74.1 }),
    ev({ name: "HackNJIT 2026", host: "NJIT", start: "2026-11-21", end: "2026-11-22", lat: 40.7424, lon: -74.1779 }),
  ], { home, today, schoolAliases: ["njit"] });
  const near = sortEvents(visible(list, { chip: "nearby", radius: 50 }));
  assert.deepEqual(near.map((e) => e.name), ["Soon", "Later", "No deadline", "HackNJIT 2026"], "Far is out of the radius, Over is over");
  assert.equal(near[0].soon, true);
  assert.equal(near[1].soon, false);
  assert.deepEqual(visible(list, { chip: "mine", radius: 50 }).map((e) => e.name), ["HackNJIT 2026"]);
  assert.deepEqual(visible(list, { chip: "nearby", radius: 5 }).map((e) => e.name), ["No deadline", "HackNJIT 2026"], "a smaller radius shrinks the list");
  assert.equal(daysUntil("2026-10-30", today), 2);
});

test("an email card and a feed card for the same event become one, blanks filled from the email", () => {
  const merged = mergeEvents(
    [{ key: "pinned:hacknjit-2026", source: "pinned", name: "HackNJIT 2026", start: "2026-11-21", deadline: null }],
    [{ key: "mail:1:0", source: "email", name: "HackNJIT 2026", start: "2026-11-21", deadline: "2026-11-15", mail: { id: "1" } }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].deadline, "2026-11-15");
  assert.deepEqual(merged[0].sources, ["pinned", "email"]);
});

test("resume lines never claim more than was typed", () => {
  assert.equal(hackathonLine({ name: "HackNJIT 2026", start: "2026-11-21" }, "Scout", "2026-11-23"), "Built Scout at HackNJIT 2026");
  assert.equal(hackathonLine({ name: "HackNJIT 2026", start: "2026-11-21" }, "", "2026-11-23"), "Participated in HackNJIT 2026");
  assert.equal(hackathonLine({ name: "SBUHacks", start: "2026-10-23" }, "[App]", ""), "Built App at SBUHacks 2026");
  assert.equal(certLine({ name: "x", resume_line: "AWS Certified Cloud Practitioner, {year}" }, "2026-12-02T10:00:00Z"), "AWS Certified Cloud Practitioner, 2026");
});
