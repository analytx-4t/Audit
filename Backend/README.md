# Backend configuration

Copy `.env.example` to `.env` and set `SMTP_PASS` to the Hostinger mailbox password. Keep `.env` out of source control.

After an image scan finishes, the backend generates a two-page PDF in the attached management-report style. DeepSeek adds a three-line, metric-based explanation after each report section. If DeepSeek is unavailable or returns an invalid response, the report still completes with clearly labeled metrics-only explanations. The PDF is emailed to the comma-separated addresses in `KPI_EMAIL_RECIPIENTS`; the daily mail queue keeps its own temporary copy under `Backend/temprory mail/data/reports` and removes that copy after sending.

For review, only the latest generated PDF is kept in the workspace-root `reports` folder as `Latest_Stockyard_Audit_Management_Report.pdf`. Each new scan replaces that preview and removes older PDFs created by this report workflow. The UI shows the preview path when generation completes. Port 465 uses implicit TLS. The app reports whether the SMTP server accepted every recipient; this does not prove delivery to an inbox. Check inbox spam/junk folders and the backend SMTP response log if a message is missing.

The image-scan flow does not include a stock register. Therefore, inventory coverage, vehicle age, model, and stock-location reconciliation are clearly marked unavailable rather than copied from example figures in the template. The report calculates scan totals, VIN format results, and duplicate VIN counts from the current job.
