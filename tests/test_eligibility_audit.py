"""Misses found by reading every card on the New page on October 20, 2026 (300 rows, the 2:00 AM UTC run).

Each line is copied from the real posting page. No network.
"""

import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from scout import dedupe, eligibility, listings, matching, posting, scoring, watch

GRAD = 2030
FIXTURES = Path(__file__).parent / "fixtures"


def verdict(text):
    return eligibility.verdict_from_text(text, GRAD, this_year=2026)


class DegreeByDate(unittest.TestCase):
    """Graduation dates written without the word "graduate"."""

    def test_pinterest_obtain_bachelors_by(self):
        text = ("Current enrollment in a school or education program in which the individual is working towards a Bachelor's "
                "in Computer Science. Obtain Bachelor's in Computer Science or related technical field by June 2028.")
        self.assertEqual(verdict(text), ("ineligible", "page requires graduation by 2028"))

    def test_booz_allen_scheduled_to_obtain(self):
        text = ("Scheduled to obtain a Bachelor's degree in a Technology, Engineering, or Mathematics field by Summer 2028 "
                "or Summer 2029")
        self.assertEqual(verdict(text)[0], "ineligible")

    def test_point72_degree_conferred(self):
        self.assertEqual(verdict("What's required\nUndergraduate degree conferred in 2025 or 2026\nStrong analytical skills")[0],
                         "ineligible")

    def test_relative_graduation(self):
        self.assertEqual(verdict("Working toward a Bachelor's. Anticipated graduation date within one year of internship")[0],
                         "ineligible")
        self.assertEqual(verdict("Bachelor's degree or within one year of graduation in Computer Science.")[0], "ineligible")

    def test_a_preferred_relative_date_does_not_count(self):
        # Corning's version is a preference; its real rule is the two-years line (StandingRules below).
        text = "Preference is for students who will be graduating within 12 months of finishing the internship."
        self.assertEqual(verdict(text)[0], "unknown")

    def test_llnl_graduate_position_is_not_a_date(self):
        text = ("If you are starting a graduate degree program in Summer 2027, you must apply for the Computing Scholar "
                "Graduate position (Posting code: REF8). Must have GPA of 3.0 or higher.")
        self.assertEqual(verdict(text)[0], "unknown")


class FullTimeStart(unittest.TestCase):
    def test_amgen_commit_to_full_time_by_july_2028(self):
        text = ("Expected continued enrollment in an accredited college or university following the internship program "
                "Must be available to accept and commit to future full-time employment by July 2028, if offered")
        self.assertEqual(verdict(text)[0], "ineligible")

    def test_pdt_full_time_roles_starting_in_2028_or_2029_beat_an_open_floor(self):
        text = ("Current Bachelor's, Master's, or PhD students pursuing degrees in rigorous fields who are eligible for "
                "full-time roles starting in 2028 or 2029. A program graduating in Fall 2027 or later")
        self.assertEqual(verdict(text), ("ineligible", "page wants a full-time start 2028 to 2029"))

    def test_datadog_and_sigma(self):
        self.assertEqual(verdict("Targeting a 2028 full-time start date\nPursuing a degree in Computer Science")[0], "ineligible")
        sigma = ("Applicants must be enrolled with a graduation date of December 2027 or later. "
                 "Ready to start work full-time by either January 2028 or June 2028 (preferred)")
        self.assertEqual(verdict(sigma)[0], "ineligible")

    def test_the_internship_itself_being_full_time_is_fine(self):
        self.assertEqual(verdict("This is a paid full-time position for the summer, May - August 2027.")[0], "unknown")
        self.assertEqual(verdict("Interns work full-time (40 hours per week) for 12 weeks during summer 2027.")[0], "unknown")
        cacI = ("Join us as an intern starting in July 2027 and ending in September 2027 for a 3-month program with the "
                "potential to transition to a full-time position.")
        self.assertEqual(verdict(cacI)[0], "unknown")

    def test_full_time_start_that_fits_is_fine(self):
        self.assertEqual(verdict("Interns should be able to start a full-time role in 2030 or 2031.")[0], "unknown")


class StandingRules(unittest.TestCase):
    def test_westinghouse_completed_sophomore_year_is_not_a_freshman_word(self):
        text = "Qualifications: Pursuing a bachelor's degree in computer science\nCompleted Sophomore year of college"
        self.assertEqual(verdict(text)[0], "ineligible")

    def test_globalfoundries_sophomore_at_application(self):
        text = "Education - At least a sophomore at time of application and actively pursuing a Bachelor's."
        self.assertEqual(verdict(text)[0], "ineligible")

    def test_src_and_corning_two_years(self):
        self.assertEqual(verdict("Completion of two years of college and current enrollment in a bachelor's degree")[0],
                         "ineligible")
        corning = ("Required Pursuing a Bachelors degree in Engineering (Minimum of 2+ years working towards the degree). "
                   "Graduation date of Dec 2027 or later.")
        self.assertEqual(verdict(corning)[0], "ineligible")

    def test_five_rings_current_sophomores(self):
        text = "This program will focus on current sophomores (those in their second year of college)."
        self.assertEqual(verdict(text)[0], "ineligible")

    def test_abb_third_or_fourth_year(self):
        text = ("Currently enrolled in a master's program, or in the third or fourth year of a bachelor's program. "
                "Master's students preferred.")
        self.assertEqual(verdict(text), ("ineligible", "page asks for third or fourth year students"))

    def test_a_named_window_with_his_year_still_wins(self):
        text = "Expected graduation dates of December 2028, May 2029, December 2029, or May 2030. Completion of two years of college."
        self.assertEqual(verdict(text)[0], "ok")

    def test_one_year_and_freshman_completion_are_fine(self):
        self.assertEqual(verdict("Must have completed at least 1 year of study.")[0], "unknown")
        self.assertEqual(verdict("Currently enrolled in or completed Freshman year of undergrad")[0], "ok")
        self.assertEqual(verdict("A minimum of 30 completed college credit hours toward a bachelor's degree")[0], "unknown")

    def test_preferred_standing_and_parentheses(self):
        self.assertEqual(verdict("Junior or senior standing preferred")[0], "unknown")
        self.assertEqual(verdict("Junior/Senior who is pursuing a degree in engineering (mechanical is preferred)")[0],
                         "ineligible")


class GraduateOnlyPages(unittest.TestCase):
    def test_metamorphic_held_bachelors(self):
        text = "MINIMUM QUALIFICATIONS - Bachelor's degree or equivalent experience, currently pursuing a PhD or MS in Computer Science"
        self.assertEqual(verdict(text)[0], "ineligible")

    def test_amgen_grad_intern(self):
        text = ("18 years or older Graduated with a bachelor's degree from an accredited college or university Currently "
                "enrolled in an MBA program for an MBA internship OR a Master's program for a Master's internship")
        self.assertEqual(verdict(text)[0], "ineligible")

    def test_kla_enrolled_graduate_student(self):
        self.assertEqual(verdict("Currently enrolled graduate student or PHD in Computer Science")[0], "ineligible")

    def test_preferred_masters_is_not_masters_only(self):
        # TikTok and GM list "Currently pursuing a Master's degree" under Preferred Qualifications.
        text = ("Minimum Qualifications:\n- Currently pursuing a Bachelor's degree in Computer Science.\n"
                "Preferred Qualifications\n- Currently pursuing a Master's degree in Computer Science.")
        self.assertEqual(verdict(text)[0], "unknown")
        self.assertEqual(verdict("Additional compensation may be available for intern PhD candidates.")[0], "unknown")

    def test_amd_page_title(self):
        text = eligibility.TITLE_PREFIX + "2027 Masters Product Development Engineering Intern/Co-op in Multiple Locations\nSkip"
        self.assertEqual(verdict(text), ("ineligible", "page title is for graduate students"))
        undergrad = eligibility.TITLE_PREFIX + "2027 Undergrad Compiler Engineering Intern / Co-op\nSkip"
        self.assertEqual(verdict(undergrad)[0], "unknown")

    def test_open_mixed_degrees_stay_open(self):
        self.assertNotEqual(verdict("Currently pursuing a BS, MS, or PhD in Computer Science.")[0], "ineligible")
        self.assertNotEqual(verdict("Must be enrolled in a bachelor's degree or graduate program")[0], "ineligible")


class OtherRuleOuts(unittest.TestCase):
    def test_harvey_previous_internship_required(self):
        text = "with a graduation date of December 2027 or later.\n- Previous internship experience is required."
        self.assertEqual(verdict(text), ("ineligible", "page requires a previous internship"))
        self.assertEqual(verdict("What you will need Previous internship/Co-op experience in software engineering")[0], "ineligible")
        self.assertEqual(verdict("What you will need\nPrevious internship/Co-op experience in software engineering")[0], "ineligible")
        self.assertEqual(verdict("Proven software development experience through at least one prior internship or co-op.")[0],
                         "ineligible")

    def test_a_prior_internship_as_a_plus_is_fine(self):
        self.assertEqual(verdict("A prior internship, a hackathon project, or something you built.")[0], "unknown")
        self.assertEqual(verdict("Previous internship or project experience is a plus.")[0], "unknown")

    def test_sierra_nevada_returning_interns(self):
        text = (eligibility.TITLE_PREFIX + "Software Engineer Intern - Summer 2027 (For SNC Summer 2026 Interns Only)\n"
                "Must be a Sophomore, Junior, or Senior in college. Must have been a SNC summer 2026 intern.")
        self.assertEqual(verdict(text)[0], "ineligible")

    def test_palantir_neurodivergent_is_a_full_time_job(self):
        self.assertEqual(verdict("You'll join Palantir as a full-time employee to build software.")[0], "ineligible")

    def test_page_says_gone(self):
        self.assertEqual(verdict("Page not found. Sorry, this role does not exist or is no longer available.")[0], "closed")
        self.assertEqual(verdict("We're sorry, the job you are trying to apply for is no longer available.")[0], "closed")
        self.assertEqual(verdict("Applications accepted on an ongoing basis until the position is filled.")[0], "unknown")

    def test_first_year_of_a_program_is_not_a_freshman_word(self):
        self.assertEqual(verdict("Your first year of the program will be spent on the production floor.")[0], "unknown")


class Deadlines(unittest.TestCase):
    TODAY = date(2026, 10, 20)

    def test_dates(self):
        d = eligibility.deadline
        self.assertEqual(d("Applications are now open for our January cohort - apply here by October 18.", self.TODAY),
                         date(2026, 10, 18))
        self.assertEqual(d("Application Deadline: November 10th, 2026", self.TODAY), date(2026, 11, 10))
        self.assertEqual(d("Positions will close to applicants on January 15, 2027.", self.TODAY), date(2027, 1, 15))
        self.assertEqual(d("Apply by January 15.", self.TODAY), date(2027, 1, 15), "no year: the nearest one")
        self.assertIsNone(d("We review applications on a rolling basis.", self.TODAY))

    def test_anthropic_fellows_past_deadline_is_closed_even_from_the_cache(self):
        url = "https://boards.greenhouse.io/anthropic/jobs/5183044008"
        text = "Applications are now open for our January cohort - apply here by October 18."
        cache = {}
        with mock.patch.object(eligibility, "fetch_text", return_value=text):
            before = eligibility.check({"url": url}, GRAD, cache, today=date(2026, 10, 10))
        self.assertEqual(before["eligibility"], "unknown")
        self.assertEqual(cache[url]["deadline"], "2026-10-18")
        after = eligibility.check({"url": url}, GRAD, cache, allow_network=False, today=self.TODAY)
        self.assertEqual(after["eligibility"], "closed")
        self.assertIn("October 18, 2026", after["eligibility_note"])


class Readers(unittest.TestCase):
    def setUp(self):
        self.original = posting._fetch

    def tearDown(self):
        posting._fetch = self.original

    def test_workday_404_is_closed(self):
        posting._fetch = lambda url, timeout=20, accept="text/html", error_body=False: (404, b'{"httpStatus":404}')
        url = "https://moog.wd5.myworkdayjobs.com/en-US/MOOG_External_Career_Site/job/Buffalo-NY/Intern--Product-Engineering_R-26-20429"
        self.assertTrue(posting.read_posting(url)["closed"])

    GDIT = "https://gdit.wd5.myworkdayjobs.com/gdit_earlytalent/job/USA-NJ-Egg-Harbor-Township/GDIT-Summer-Internship-Program---Summer-2027-Software-Development-Internship--_RQ230643"

    def test_workday_403_s22_is_closed(self):
        # Workday's real answer for GDIT's unposted intern on October 20, 2026.
        body = b'{"errorCode":"S22","errorCaseId":"043BDBMVHJI699","httpStatus":403,"message":"permission denied","messageParams":{}}'
        posting._fetch = lambda url, timeout=20, accept="text/html", error_body=False: (403, body if error_body else None)
        self.assertTrue(posting.read_posting(self.GDIT)["closed"])

    def test_other_workday_403s_are_not_closed(self):
        # A 403 without S22 (a block page, a different error) says nothing about the posting, so it stays unread.
        for body in (b'<html>Access denied</html>', b'{"errorCode":"S99","httpStatus":403}', None):
            posting._fetch = lambda url, timeout=20, accept="text/html", error_body=False, b=body: (403, b if error_body else None)
            post = posting.read_workday(self.GDIT)
            self.assertFalse(post and post.get("closed"), body)

    def test_s22_reaches_the_page_check_as_closed(self):
        body = b'{"errorCode":"S22","httpStatus":403}'
        posting._fetch = lambda url, timeout=20, accept="text/html", error_body=False: (403, body if error_body else None)
        self.assertEqual(eligibility.fetch_text(self.GDIT), eligibility.CLOSED)

    def test_amazon_404_is_closed(self):
        posting._fetch = lambda url, timeout=20, accept="text/html", error_body=False: (404, None)
        url = "https://www.amazon.jobs/en/jobs/10412530/software-development-engineer-intern-aws-data-services-fall-2026-us"
        self.assertTrue(posting.read_posting(url)["closed"])

    def test_more_boards_are_read(self):
        for url in ("https://jobs.smartrecruiters.com/WellmarkInc/744000156043218",
                    "https://jobs.jobvite.com/src-inc/job/on4GAfwr?nl=1",
                    "https://jobs.l3harris.com/job/Clifton-Software-Engineering-Intern-NJ-07014/1413358200/?ats=successfactors",
                    "https://careers.amd.com/jobs/91230?icims=1",
                    "https://ats.rippling.com/rippling/jobs/f64b6158-9534-4bab-9457-45556166b262",
                    "https://careers.datadoghq.com/detail/8052118/?gh_jid=8052118",
                    "https://jobs.apple.com/en-us/details/200689488"):
            self.assertTrue(eligibility.is_readable_board(url), url)
        self.assertFalse(eligibility.is_readable_board("https://example.com/jobs/1?ats=other"))


class WorkdayDuplicates(unittest.TestCase):
    def row(self, company, title, url):
        return {"company": company, "title": title, "url": url, "source": "simplify", "date_updated": 1, "date_posted": 1}

    def test_one_requisition_is_one_card(self):
        pairs = [
            ("https://salesforce.wd12.myworkdayjobs.com/Futureforce_Internships/job/SF/Intern---Software-Engineer_JR364911",
             "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/SF/Intern---Software-Engineer_JR364911-1"),
            ("https://spgi.wd5.myworkdayjobs.com/Kensho_Careers/job/Cambridge-MA/Software-Engineer---Summer-Intern-2027_331717-1",
             "https://spgi.wd5.myworkdayjobs.com/en-US/SPGI_Careers/job/Cambridge-MA/Software-Engineer---Summer-Intern-2027_331717-2"),
            ("https://micron.wd1.myworkdayjobs.com/en-US/External/job/Boise-ID---Main-Site/Intern---SMAI-Probe-AI-Engineer_JR114094",
             "https://micron.wd1.myworkdayjobs.com/External/job/Boise-ID---Main-Site/Intern---SMAI-Probe-AI-Engineer_JR114094"),
            ("https://bah.wd1.myworkdayjobs.com/en-US/BAH_Jobs/job/Fayetteville-NC/University--Software-Engineer-Intern_R0251802",
             "https://bah.wd1.myworkdayjobs.com/bah_jobs/job/Fayetteville-NC/University--Software-Engineer-Intern_R0251802"),
        ]
        for a, b in pairs:
            kept = dedupe.dedupe([self.row("Kensho", "Software Engineer Intern - Summer 2027", a),
                                  self.row("S&P Global", "SWE Intern", b)])
            self.assertEqual(len(kept), 1, a)

    def test_different_requisitions_stay_apart(self):
        kept = dedupe.dedupe([
            self.row("Amgen", "Software Engineer Intern",
                     "https://amgen.wd1.myworkdayjobs.com/careers/job/Remote/Undergrad-Intern---Software-Engineer_R-255719"),
            self.row("Amgen", "Software Engineer Intern - Grad",
                     "https://amgen.wd1.myworkdayjobs.com/careers/job/Remote/Grad-Intern---Software-Engineer_R-255745")])
        self.assertEqual(len(kept), 2)


class ShownRowsAreAllChecked(unittest.TestCase):
    def test_ineligible_rows_do_not_pull_unchecked_rows_into_view(self):
        """With check_pages=5, the five rows the New page shows first must all have been read, even when
        some of the top-scored rows turned out ineligible and sank."""
        raw = {"simplify": listings.load_json(FIXTURES / "simplify.json")}
        calls = []

        def fake_check(item, grad, cache, allow_network=True, today=None):
            calls.append(item)
            bad = len(calls) <= 3  # the three best-scored rows are ruled out by their pages
            item["eligibility"], item["eligibility_note"] = ("ineligible", "test") if bad else ("unknown", "read")
            return item

        with mock.patch.object(eligibility, "check", side_effect=fake_check), \
             mock.patch.object(eligibility, "load_cache", return_value={}), \
             mock.patch.object(watch, "could_push", return_value=False), \
             mock.patch.object(watch, "on_board", return_value=False):
            matches, _ = watch.run(raw, matching.load_targets(), scoring.load_weights(), check_pages=5,
                                   allow_network=False, now=1_800_000_000, save=False)
        shown = [m for m in matches if m["eligibility"] != "ineligible"][:5]
        self.assertEqual(len(shown), 5)
        for m in shown:
            self.assertEqual(m["eligibility_note"], "read", m["title"])


if __name__ == "__main__":
    unittest.main()
