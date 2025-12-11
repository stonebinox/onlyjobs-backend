## Backend Notes

### Email notifications (SendGrid)
- Set `SENDGRID_API_KEY` in the backend environment.
- Optional: set `SENDGRID_FROM` (default: `onlyjobs <no-reply@onlyjobs.com>`).
- Matching runs send a daily summary email when matches are created (top 5 included) and mention the $0.30 wallet deduction. Email failures are logged but do not block matching.
