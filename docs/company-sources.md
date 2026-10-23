# Direct company sources

Scout reads the public boards under `boards:` in `config/targets.yaml` every run.
These do not depend on a company first appearing in a community internship list,
or on the rotating discovered-board batch. Only internship, co-op, and fellowship
titles enter the normal role, location, degree, graduation-year, and deduplication
pipeline. Adding a board does not make its full-time roles student opportunities.

## Added October 23, 2026

Each board below was linked from the company's official website and verified
through Scout's existing Ashby reader. All four responded successfully. At the
time of verification, their 144 combined open listings contained no internship,
co-op, or fellowship titles; zero imported rows is an expected result.

| Company | Official source | Ashby board | Open listings at verification |
|---|---|---|---:|
| Mecka | https://www.mecka.ai/careers | `mecka.ai` | 54 |
| TypeSafe AI | https://typesafe.ai/ (Open roles) | `typesafe-ai` | 15 |
| General Medicine | https://generalmedicine.co/company/careers | `general-medicine` | 16 |
| Supabase | https://supabase.com/careers | `supabase` | 59 |

The public endpoint is
`https://api.ashbyhq.com/posting-api/job-board/<board>`. Scout supplies its normal
User-Agent and JSON Accept headers. No login, API key, paid service, or browser
automation is required. Existing company tiers and alert rules apply.

The company branded General is General Medicine, the healthcare storefront at
`generalmedicine.co`, rather than the unrelated post-hospitalist organization at
`generalmedicine.com`. Sources are identified by official links, not funding
graphics or a company-name search alone.

