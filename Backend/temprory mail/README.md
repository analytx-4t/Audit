# Temporary daily mail

This optional feature queues a copy of each generated audit PDF and emails each
report from the previous calendar day at 9:00 AM in `Asia/Kolkata`. It uses the
same SMTP and recipient environment variables as the core mailing feature and
the same email subject, body, and PDF attachment format.

Set `TEMPORARY_MAIL_TIMEZONE` to another IANA timezone if needed. If the backend
starts after 9:00 AM, it checks for previous-day reports on startup and sends
them once. A report that could not be sent remains queued and is retried at a
later daily run.

Runtime queue data and queued PDFs are stored in this folder's ignored `data`
directory. To remove this optional feature, remove this folder, its import and
startup call in `Backend/server.js`, the report-recording call in
`Backend/server.js`, and its `data` ignore entry in `Backend/.gitignore`.
