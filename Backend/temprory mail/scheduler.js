import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

const featureDirectory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.join(featureDirectory, "data");
const reportsDirectory = path.join(dataDirectory, "reports");
const statePath = path.join(dataDirectory, "state.json");

let state;
let stateQueue = Promise.resolve();
let schedulerStarted = false;
let deliveryInProgress = false;
let lastAttemptDate = "";
let scheduleTimezone;
let scheduleFormatter;

function getScheduleFormatter() {
  if (!scheduleFormatter) {
    scheduleTimezone = process.env.TEMPORARY_MAIL_TIMEZONE || "Asia/Kolkata";
    scheduleFormatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: scheduleTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  }
  return scheduleFormatter;
}

function getLocalParts(date) {
  return Object.fromEntries(
    getScheduleFormatter().formatToParts(date).map(({ type, value }) => [type, value]),
  );
}

export function getLocalDate(date) {
  const parts = getLocalParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getPreviousDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

async function loadState() {
  if (state) return state;

  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not read temporary mail queue: ${error.message}`);
    }
    state = { reports: [] };
  }

  if (!state || !Array.isArray(state.reports)) {
    throw new Error("Temporary mail queue has an invalid format.");
  }
  return state;
}

async function saveState() {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2), "utf8");
  await rename(temporaryPath, statePath);
}

function withStateLock(operation) {
  const result = stateQueue.then(operation);
  stateQueue = result.catch(() => {});
  return result;
}

export async function recordTemporaryMailReport({ jobId, totalFiles, reportBuffer, createdAt = new Date() }) {
  const reportId = randomUUID();
  const reportFileName = `${reportId}.pdf`;
  const reportPath = path.join(reportsDirectory, reportFileName);

  await mkdir(reportsDirectory, { recursive: true });
  await writeFile(reportPath, reportBuffer, { flag: "wx" });

  try {
    await withStateLock(async () => {
      const currentState = await loadState();
      currentState.reports.push({
        id: reportId,
        jobId,
        totalFiles,
        reportFileName,
        reportDate: getLocalDate(createdAt),
        status: "pending",
      });
      await saveState();
    });
  } catch (error) {
    await rm(reportPath, { force: true });
    throw error;
  }
}

async function sendQueuedReport(report) {
  const requiredSettings = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"];
  const missingSettings = requiredSettings.filter(
    (setting) => !process.env[setting]?.trim(),
  );
  const recipients = (process.env.KPI_EMAIL_RECIPIENTS || "")
    .split(",")
    .map((recipient) => recipient.trim())
    .filter(Boolean);

  if (recipients.length === 0) missingSettings.push("KPI_EMAIL_RECIPIENTS");
  if (missingSettings.length > 0) {
    throw new Error(`Missing email settings: ${missingSettings.join(", ")}`);
  }

  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 465;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be an integer between 1 and 65535.");
  }

  const reportBuffer = await readFile(path.join(reportsDirectory, report.reportFileName));
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  try {
    const reportDate = new Date().toISOString().slice(0, 10);
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: recipients,
      subject: `Stockyard audit report - ${reportDate}`,
      text: `The stockyard audit report for ${report.totalFiles} uploaded image(s) is attached as a PDF. If scans failed, the report includes the failed-image statistics. SMTP acceptance confirms receipt by the mail server, not final inbox delivery; check spam/junk if it is missing.`,
      attachments: [
        {
          filename: `Stockyard_Audit_Management_Report_${reportDate}.pdf`,
          content: reportBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    const acceptedAddresses = (Array.isArray(info.accepted) ? info.accepted : [])
      .map((recipient) =>
        String(typeof recipient === "string" ? recipient : recipient.address).toLowerCase(),
      );
    const allRecipientsAccepted = recipients.every((recipient) =>
      acceptedAddresses.includes(recipient.toLowerCase()),
    );
    if (!allRecipientsAccepted) {
      throw new Error(
        `SMTP accepted the report for ${acceptedAddresses.length} of ${recipients.length} recipient(s).`,
      );
    }
    console.info(
      `[Temporary mail] SMTP accepted report for job ${report.jobId}: messageId=${info.messageId || "unavailable"}`,
    );
  } finally {
    transporter.close();
  }
}

async function deliverPreviousDayReports(today) {
  const previousDate = getPreviousDate(today);
  const pendingReports = await withStateLock(async () => {
    const currentState = await loadState();
    return currentState.reports.filter(
      (report) => report.status === "pending" && report.reportDate <= previousDate,
    );
  });

  for (const report of pendingReports) {
    try {
      await sendQueuedReport(report);
      await withStateLock(async () => {
        const currentState = await loadState();
        const storedReport = currentState.reports.find(({ id }) => id === report.id);
        if (storedReport) {
          storedReport.status = "sent";
          storedReport.sentAt = new Date().toISOString();
          await saveState();
        }
      });
      try {
        await rm(path.join(reportsDirectory, report.reportFileName), { force: true });
      } catch (error) {
        console.warn(
          `[Temporary mail] Sent report for job ${report.jobId} but could not remove its queued PDF:`,
          error,
        );
      }
    } catch (error) {
      console.error(
        `[Temporary mail] Failed to send queued report for job ${report.jobId}:`,
        error,
      );
    }
  }
}

async function checkSchedule() {
  if (deliveryInProgress) return;

  const now = new Date();
  const parts = getLocalParts(now);
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (parts.hour < "09" || lastAttemptDate === today) return;

  lastAttemptDate = today;
  deliveryInProgress = true;
  try {
    await deliverPreviousDayReports(today);
  } catch (error) {
    console.error("[Temporary mail] Daily report delivery could not run:", error);
  } finally {
    deliveryInProgress = false;
  }
}

export function startTemporaryMailScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  console.info(
    `[Temporary mail] Daily delivery enabled for 9:00 AM (${scheduleTimezone})`,
  );
  void checkSchedule();
  setInterval(() => {
    void checkSchedule();
  }, 30_000);
}
