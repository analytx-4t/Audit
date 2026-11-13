# Backend configuration

Copy `.env.example` to `.env` and set `SMTP_PASS` to the Hostinger mailbox password. Keep `.env` out of source control.

After an image scan finishes, the backend generates a two-page PDF in the attached management-report style. DeepSeek adds a three-line, metric-based explanation after each report section. If DeepSeek is unavailable or returns an invalid response, the report still completes with clearly labeled metrics-only explanations. The PDF is emailed to the comma-separated addresses in `KPI_EMAIL_RECIPIENTS`; the daily mail queue keeps its own temporary copy under `Backend/temprory mail/data/reports` and removes that copy after sending.

For review, only the latest generated PDF is kept in the workspace-root `reports` folder as `Latest_Stockyard_Audit_Management_Report.pdf`. Each new scan replaces that preview and removes older PDFs created by this report workflow. The UI shows the preview path when generation completes. Port 465 uses implicit TLS. The app reports whether the SMTP server accepted every recipient; this does not prove delivery to an inbox. Check inbox spam/junk folders and the backend SMTP response log if a message is missing.

The image-scan flow does not include a stock register. Therefore, inventory coverage, vehicle age, model, and stock-location reconciliation are clearly marked unavailable rather than copied from example figures in the template. The report calculates scan totals, VIN format results, and duplicate VIN counts from the current job.

## Report email: reliability and troubleshooting

- Transient SMTP errors are retried (5s, 20s, 60s). If the email still fails, the report is saved to `reports/outbox/` and re-sent every `MAIL_RETRY_INTERVAL_MIN` minutes and on every server start, so restarts and mail-server outages no longer lose reports.
- Every attempt is logged to `reports/mail-log.jsonl` (time, status, SMTP response). Check this first when someone says an email did not arrive.
- On start the server logs `SMTP ... reachable and login OK` or `SMTP check FAILED`. On DigitalOcean, outbound SMTP ports (25/465/587) are blocked on some droplets: if the check fails with a timeout, test from the droplet with `nc -vz smtp.hostinger.com 465` and ask DigitalOcean support to unblock SMTP, or switch to an HTTP email API.
- The email is sent when a scan job finishes, so its time follows the scan. The job runs in memory: if the process is restarted (deploy, pm2 restart, out-of-memory kill) while a job is running, that job is lost. Check `pm2 logs` / `dmesg | grep -i kill` for OOM kills on small droplets.
- Dates use `REPORT_TIMEZONE` (default Asia/Kolkata).

## OCR accuracy testing

- `node scripts/ocr_eval.mjs` — runs the image folders through the pipeline and scores against `scripts/ground_truth.json`.
- `node scripts/e2e_test.mjs` — with the server running, uploads every folder over HTTP exactly like the frontend and checks that every image gets exactly one result, in upload order, with a PDF report.
