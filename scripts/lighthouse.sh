#!/usr/bin/env bash
# Lighthouse for the landing and board pages, desktop and mobile, against one base URL.
# Usage: scripts/lighthouse.sh <base-url> <label> [pages] [forms] [runs]
#   scripts/lighthouse.sh http://localhost:4000 local
#   scripts/lighthouse.sh https://example.onrender.com live "board" "mobile" 5
# Single Lighthouse runs vary a lot (the same build scored 76 and 100), so each page is run <runs> times (default 5,
# as Lighthouse's own variability guidance suggests) and the run with the median performance score is kept as
# docs/lighthouse/<label>-<page>-<form>.report.{html,json}. Every run's score is printed; failed traces are retried,
# never counted.
set -uo pipefail
base="${1:?base url}"
label="${2:?label}"
pages="${3:-landing board}"
forms="${4:-desktop mobile}"
runs="${5:-5}"
out="docs/lighthouse"
tmp="$out/.runs"
mkdir -p "$out" "$tmp"
summary() {
  node -e '
    const r = require(process.argv[1]); const c = r.categories, a = r.audits;
    if (r.runtimeError) { console.log("ERROR", r.runtimeError.code); process.exit(1); }
    const s = (k) => Math.round(c[k].score * 100);
    console.log([s("performance"), "a11y", s("accessibility"), "bp", s("best-practices"), "seo", s("seo"),
      "FCP", a["first-contentful-paint"].displayValue, "LCP", a["largest-contentful-paint"].displayValue,
      "TBT", a["total-blocking-time"].displayValue, "CLS", a["cumulative-layout-shift"].displayValue].join(" "));
  ' "$(pwd -W)/$1"
}
for page in $pages; do
  path=$([ "$page" = landing ] && echo "/" || echo "/board")
  for form in $forms; do
    preset=$([ "$form" = desktop ] && echo "--preset=desktop" || echo "--form-factor=mobile")
    name="$label-$page-$form"
    rm -f "$tmp/$name"-*
    done_runs=0
    attempts=0
    while [ "$done_runs" -lt "$runs" ] && [ "$attempts" -lt $((runs * 2)) ]; do
      attempts=$((attempts + 1))
      run="$tmp/$name-$done_runs"
      npx --yes lighthouse@13.6.0 "$base$path" $preset --quiet --output=html --output=json --output-path="$run" \
        --only-categories=performance,accessibility,best-practices,seo --chrome-flags="--headless=new" >/dev/null 2>&1
      if [ -f "$run.report.json" ] && line=$(summary "$run.report.json"); then
        echo "$line" > "$run.score"
        done_runs=$((done_runs + 1))
      else
        rm -f "$run".report.*
      fi
    done
    [ "$done_runs" -gt 0 ] || { echo "$name: no successful run"; continue; }
    scores=$(for f in "$tmp/$name"-*.score; do echo "$(cut -d' ' -f1 "$f") ${f%.score}"; done | sort -n)
    median=$(echo "$scores" | sed -n "$(( (done_runs + 1) / 2 ))p" | cut -d' ' -f2)
    cp "$median.report.json" "$out/$name.report.json"
    cp "$median.report.html" "$out/$name.report.html"
    echo "$name median perf $(cat "$median.score")   (runs: $(echo "$scores" | cut -d' ' -f1 | tr '\n' ' '))"
  done
done
rm -rf "$tmp"
