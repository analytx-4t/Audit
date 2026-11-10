# Backend configuration

Copy `.env.example` to `.env` and set `SMTP_PASS` to the Hostinger mailbox password. Keep `.env` out of source control.

After an image scan finishes, the backend generates a two-page PDF in the attached management-report style, saves it under the workspace-root `reports` folder, and emails only that PDF to the comma-separated addresses in `KPI_EMAIL_RECIPIENTS`. Failed scans still produce and save/email a PDF with failure statistics. The UI shows the saved report path when generation completes. Port 465 uses implicit TLS. The app reports whether the SMTP server accepted every recipient; this does not prove delivery to an inbox. Check inbox spam/junk folders and the backend SMTP response log if a message is missing.

The image-scan flow does not include a stock register. Therefore, inventory coverage, vehicle age, model, and stock-location reconciliation are clearly marked unavailable rather than copied from example figures in the template. The report calculates scan totals, VIN format results, and duplicate VIN counts from the current job.
