#!/usr/bin/env bash
# Lighthouse for the landing and board pages, desktop and mobile, against one base URL.
# Usage: scripts/lighthouse.sh <base-url> <label> [pages] [forms]
#   scripts/lighthouse.sh http://localhost:4000 local
#   scripts/lighthouse.sh https://example.onrender.com live "board" "mobile"
# Reports (HTML + JSON) go to docs/lighthouse/<label>-<page>-<form>.report.{html,json}; one score line per run.
# Lighthouse occasionally fails to record a trace (headless Chrome); a failed run is retried up to 3 times, never
# reported as a score.
set -uo pipefail
base="${1:?base url}"
label="${2:?label}"
pages="${3:-landing board}"
forms="${4:-desktop mobile}"
out="docs/lighthouse"
mkdir -p "$out"
for page in $pages; do
  path=$([ "$page" = landing ] && echo "/" || echo "/board")
  for form in $forms; do
    preset=$([ "$form" = desktop ] && echo "--preset=desktop" || echo "--form-factor=mobile")
    name="$out/$label-$page-$form"
    for attempt in 1 2 3; do
      rm -f "$name.report.json" "$name.report.html"
      npx --yes lighthouse@13.6.0 "$base$path" $preset --quiet --output=html --output=json --output-path="$name" \
        --only-categories=performance,accessibility,best-practices,seo --chrome-flags="--headless=new" >/dev/null 2>&1
      [ -f "$name.report.json" ] || { echo "$label-$page-$form attempt $attempt: no report"; continue; }
      node -e '
        const r = require(process.argv[1]); const c = r.categories, a = r.audits;
        if (r.runtimeError) { console.log(process.argv[2], "attempt", process.argv[3] + ":", r.runtimeError.code); process.exit(1); }
        const s = (k) => Math.round(c[k].score * 100);
        console.log([process.argv[2], "perf", s("performance"), "a11y", s("accessibility"), "bp", s("best-practices"), "seo", s("seo"),
          "FCP", a["first-contentful-paint"].displayValue, "LCP", a["largest-contentful-paint"].displayValue,
          "TBT", a["total-blocking-time"].displayValue, "CLS", a["cumulative-layout-shift"].displayValue].join(" "));
      ' "$(pwd -W)/$name.report.json" "$label-$page-$form" "$attempt" && break
    done
  done
done
