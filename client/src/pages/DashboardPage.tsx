/* eslint-disable react-hooks/set-state-in-effect */
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { formatDate, formatRelativeDate, getExpiryColor } from "@/lib/utils";
import { getDomain as getRegistrableDomain } from "tldts";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  Edit3,
  FileText,
  Filter,
  Gauge,
  Globe,
  HelpCircle,
  Layers,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Send,
  Shield,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { NotificationsModal } from "@/components/NotificationsModal";
import { IpCertificatesBadge } from "@/components/IpCertificatesBadge";
import type { IpCertificateResult } from "@shared/types/certificates";
import type { WebhookConfig } from "@shared/types/notifications";

interface Domain {
  id: number;
  domain: string;
  notes: string | null;
  lastCheckedAt: string | null;
  certExpiresAt: string | null;
  certIssuer: string | null;
  certIp: string | null;
  certError: string | null;
  lastIpResults: IpCertificateResult[] | null;
  createdAt: string;
}

type SortBy =
  | "domain"
  | "baseDomain"
  | "expiry"
  | "daysLeft"
  | "lastChecked"
  | "issuer"
  | "status"
  | "created"
  | "notesLength";
type SortDirection = "asc" | "desc";
type StatusFilter = "all" | "healthy" | "warning" | "critical" | "expired" | "unknown" | "error";
type ExpiryFilter = "all" | "expired" | "today" | "7" | "30" | "90" | "valid" | "unknown";
type CheckedFilter = "all" | "checked" | "unchecked" | "24h" | "7d" | "stale";
type NotesFilter = "all" | "with" | "without";
type DomainTypeFilter = "all" | "root" | "subdomain";
type GroupMode = "none" | "base";

type DomainStatus = "healthy" | "warning" | "critical" | "expired" | "unknown" | "error";

interface DomainGroup {
  key: string;
  rootDomain: Domain | null;
  childDomains: Domain[];
  allDomains: Domain[];
}

interface StatusMeta {
  key: DomainStatus;
  label: string;
  tone: string;
  dot: string;
  priority: number;
  icon: ReactNode;
}

interface ConfigExportPayload {
  version: number;
  app: string;
  exportedAt: string;
  user: {
    email: string;
    name: string | null;
    notificationThresholdDays: number | null;
  };
  domains: Array<{
    domain: string;
    notes: string | null;
  }>;
  notifications?: { emailEnabled: boolean; webhooks: WebhookConfig[] };
}

type EmailStatus = "PENDING" | "SENT" | "FAILED" | "SKIPPED";
type EmailPurpose = "CERT_ALERT" | "TEST_EMAIL" | "VERIFY_EMAIL" | "PASSWORD_RESET";

interface EmailHistoryItem {
  id: number;
  requestedAt: string;
  sentAt: string | null;
  status: EmailStatus;
  purpose: EmailPurpose;
  toEmail: string;
  subject: string;
  domains: string | null;
  preview: string | null;
  error: string | null;
  updatedAt: string;
}

interface EmailHistorySummary {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}

interface NotificationSettings {
  adminDefaultThresholdDays: number;
  userThresholdDays: number | null;
  effectiveThresholdDays: number;
  minThresholdDays: number;
  maxThresholdDays: number;
  cronExpression: string;
}

interface UpcomingEmailDomain {
  domain: string;
  certExpiresAt: string;
  daysUntilExpiry: number;
}

interface UpcomingFailedEmailDomain {
  domain: string;
  error: string;
}

interface UpcomingEmailPlan {
  toEmail: string;
  subject: string;
  plannedFor: string;
  thresholdDays: number;
  domains: UpcomingEmailDomain[];
  failedDomains: UpcomingFailedEmailDomain[];
  preview: string;
  html: string;
  sentToday: boolean;
}

interface UpcomingEmailResponse {
  settings: NotificationSettings;
  nextRunAt: string | null;
  emails: UpcomingEmailPlan[];
  note: string | null;
}

const emailPurposeLabels: Record<EmailPurpose, string> = {
  CERT_ALERT: "Certificate alert",
  TEST_EMAIL: "Test email",
  VERIFY_EMAIL: "Verification",
  PASSWORD_RESET: "Password reset",
};

const emailStatusLabels: Record<EmailStatus, string> = {
  PENDING: "Delivery pending",
  SENT: "Sent",
  FAILED: "Failed",
  SKIPPED: "Skipped",
};

const emailStatusTones: Record<EmailStatus, string> = {
  PENDING: "border-amber-200 bg-amber-50 text-amber-700",
  SENT: "border-emerald-200 bg-emerald-50 text-emerald-700",
  FAILED: "border-rose-200 bg-rose-50 text-rose-700",
  SKIPPED: "border-slate-200 bg-slate-50 text-slate-600",
};

const MS_PER_DAY = 1000 * 60 * 60 * 24;

const statusOrder: Record<DomainStatus, number> = {
  error: 0,
  expired: 1,
  critical: 2,
  warning: 3,
  unknown: 4,
  healthy: 5,
};

const sortLabels: Record<SortBy, string> = {
  domain: "Domain",
  baseDomain: "Base domain",
  expiry: "Expiry date",
  daysLeft: "Days left",
  lastChecked: "Last checked",
  issuer: "Issuer",
  status: "Risk status",
  created: "Date added",
  notesLength: "Notes length",
};

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getExpiryTimestamp(domain: Domain): number | null {
  return domain.certExpiresAt ? new Date(domain.certExpiresAt).getTime() : null;
}

function getLastCheckedTimestamp(domain: Domain): number | null {
  return domain.lastCheckedAt ? new Date(domain.lastCheckedAt).getTime() : null;
}

function getDaysUntilExpiry(domain: Domain): number | null {
  const expiry = getExpiryTimestamp(domain);
  if (expiry === null) {
    return null;
  }
  return Math.ceil((expiry - Date.now()) / MS_PER_DAY);
}

function getAgeInDays(date: string | null): number | null {
  if (!date) {
    return null;
  }
  return Math.floor((Date.now() - new Date(date).getTime()) / MS_PER_DAY);
}

function getDomainHost(domain: string): string {
  const colonIndex = domain.indexOf(":");
  if (colonIndex === -1) {
    return domain;
  }

  const host = domain.slice(0, colonIndex);
  const port = domain.slice(colonIndex + 1).split(":", 1)[0];
  return host && /^\d+$/.test(port) ? host : domain;
}

function getBaseDomain(domain: string): string {
  const host = getDomainHost(domain);
  return getRegistrableDomain(host) || host;
}

function isRootDomain(domain: Domain): boolean {
  return getDomainHost(domain.domain) === getBaseDomain(domain.domain);
}

function pluralize(count: number, singular: string, plural = singular + "s"): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/[`*_~>#-]/g, " ")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function getStatusMeta(domain: Domain): StatusMeta {
  const daysLeft = getDaysUntilExpiry(domain);

  if (domain.certError) {
    return {
      key: "error",
      label: "Error",
      tone: "border-rose-200 bg-rose-50 text-rose-700",
      dot: "bg-rose-500",
      priority: statusOrder.error,
      icon: <XCircle className="h-3.5 w-3.5" />,
    };
  }

  if (daysLeft === null) {
    return {
      key: "unknown",
      label: "Unknown",
      tone: "border-slate-200 bg-slate-50 text-slate-600",
      dot: "bg-slate-400",
      priority: statusOrder.unknown,
      icon: <HelpCircle className="h-3.5 w-3.5" />,
    };
  }

  if (daysLeft < 0) {
    return {
      key: "expired",
      label: "Expired",
      tone: "border-red-200 bg-red-50 text-red-700",
      dot: "bg-red-500",
      priority: statusOrder.expired,
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
    };
  }

  if (daysLeft <= 7) {
    return {
      key: "critical",
      label: "Critical",
      tone: "border-orange-200 bg-orange-50 text-orange-700",
      dot: "bg-orange-500",
      priority: statusOrder.critical,
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
    };
  }

  if (daysLeft <= 30) {
    return {
      key: "warning",
      label: "Warning",
      tone: "border-amber-200 bg-amber-50 text-amber-700",
      dot: "bg-amber-500",
      priority: statusOrder.warning,
      icon: <CalendarClock className="h-3.5 w-3.5" />,
    };
  }

  return {
    key: "healthy",
    label: "Healthy",
    tone: "border-emerald-200 bg-emerald-50 text-emerald-700",
    dot: "bg-emerald-500",
    priority: statusOrder.healthy,
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
  };
}

function statusMatches(domain: Domain, statusFilter: StatusFilter): boolean {
  return statusFilter === "all" || getStatusMeta(domain).key === statusFilter;
}

function expiryMatches(domain: Domain, expiryFilter: ExpiryFilter): boolean {
  const daysLeft = getDaysUntilExpiry(domain);

  switch (expiryFilter) {
    case "expired":
      return daysLeft !== null && daysLeft < 0;
    case "today":
      return daysLeft === 0;
    case "7":
      return daysLeft !== null && daysLeft >= 0 && daysLeft <= 7;
    case "30":
      return daysLeft !== null && daysLeft >= 0 && daysLeft <= 30;
    case "90":
      return daysLeft !== null && daysLeft >= 0 && daysLeft <= 90;
    case "valid":
      return daysLeft !== null && daysLeft > 30;
    case "unknown":
      return daysLeft === null;
    default:
      return true;
  }
}

function checkedMatches(domain: Domain, checkedFilter: CheckedFilter): boolean {
  const age = getAgeInDays(domain.lastCheckedAt);

  switch (checkedFilter) {
    case "checked":
      return domain.lastCheckedAt !== null;
    case "unchecked":
      return domain.lastCheckedAt === null;
    case "24h":
      return age !== null && age <= 1;
    case "7d":
      return age !== null && age <= 7;
    case "stale":
      return age === null || age > 7;
    default:
      return true;
  }
}

function compareNullableNumbers(
  a: number | null,
  b: number | null,
  direction: SortDirection,
): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return direction === "asc" ? a - b : b - a;
}

function compareStrings(a: string, b: string, direction: SortDirection): number {
  const result = a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  return direction === "asc" ? result : -result;
}

function compareDomains(
  a: Domain,
  b: Domain,
  sortBy: SortBy,
  sortDirection: SortDirection,
): number {
  let result = 0;

  if (sortBy === "domain") {
    result = compareStrings(a.domain, b.domain, sortDirection);
  } else if (sortBy === "baseDomain") {
    result = compareStrings(getBaseDomain(a.domain), getBaseDomain(b.domain), sortDirection);
  } else if (sortBy === "expiry" || sortBy === "daysLeft") {
    result = compareNullableNumbers(getExpiryTimestamp(a), getExpiryTimestamp(b), sortDirection);
  } else if (sortBy === "lastChecked") {
    result = compareNullableNumbers(
      getLastCheckedTimestamp(a),
      getLastCheckedTimestamp(b),
      sortDirection,
    );
  } else if (sortBy === "issuer") {
    result = compareStrings(a.certIssuer || "", b.certIssuer || "", sortDirection);
  } else if (sortBy === "status") {
    result = compareNullableNumbers(
      getStatusMeta(a).priority,
      getStatusMeta(b).priority,
      sortDirection,
    );
  } else if (sortBy === "notesLength") {
    result = compareNullableNumbers(a.notes?.length ?? 0, b.notes?.length ?? 0, sortDirection);
  } else {
    result = compareNullableNumbers(
      new Date(a.createdAt).getTime(),
      new Date(b.createdAt).getTime(),
      sortDirection,
    );
  }

  return result !== 0 ? result : compareStrings(a.domain, b.domain, "asc");
}

function compareGroups(
  a: DomainGroup,
  b: DomainGroup,
  sortBy: SortBy,
  sortDirection: SortDirection,
): number {
  if (sortBy === "domain" || sortBy === "baseDomain") {
    return compareStrings(a.key, b.key, sortDirection);
  }

  if (sortBy === "status") {
    const aPriority = Math.min(...a.allDomains.map((domain) => getStatusMeta(domain).priority));
    const bPriority = Math.min(...b.allDomains.map((domain) => getStatusMeta(domain).priority));
    const result = compareNullableNumbers(aPriority, bPriority, sortDirection);
    return result !== 0 ? result : compareStrings(a.key, b.key, "asc");
  }

  if (sortBy === "lastChecked") {
    const aChecked = Math.max(
      ...a.allDomains.map((domain) => getLastCheckedTimestamp(domain) ?? Number.NEGATIVE_INFINITY),
    );
    const bChecked = Math.max(
      ...b.allDomains.map((domain) => getLastCheckedTimestamp(domain) ?? Number.NEGATIVE_INFINITY),
    );
    const result = compareNullableNumbers(
      aChecked === Number.NEGATIVE_INFINITY ? null : aChecked,
      bChecked === Number.NEGATIVE_INFINITY ? null : bChecked,
      sortDirection,
    );
    return result !== 0 ? result : compareStrings(a.key, b.key, "asc");
  }

  if (sortBy === "issuer") {
    const aIssuer = a.allDomains.find((domain) => domain.certIssuer)?.certIssuer || "";
    const bIssuer = b.allDomains.find((domain) => domain.certIssuer)?.certIssuer || "";
    const result = compareStrings(aIssuer, bIssuer, sortDirection);
    return result !== 0 ? result : compareStrings(a.key, b.key, "asc");
  }

  if (sortBy === "notesLength") {
    const aNotes = a.allDomains.reduce((total, domain) => total + (domain.notes?.length ?? 0), 0);
    const bNotes = b.allDomains.reduce((total, domain) => total + (domain.notes?.length ?? 0), 0);
    const result = compareNullableNumbers(aNotes, bNotes, sortDirection);
    return result !== 0 ? result : compareStrings(a.key, b.key, "asc");
  }

  if (sortBy === "created") {
    const aCreated = Math.min(
      ...a.allDomains.map((domain) => new Date(domain.createdAt).getTime()),
    );
    const bCreated = Math.min(
      ...b.allDomains.map((domain) => new Date(domain.createdAt).getTime()),
    );
    const result = compareNullableNumbers(aCreated, bCreated, sortDirection);
    return result !== 0 ? result : compareStrings(a.key, b.key, "asc");
  }

  const aExpiry = a.allDomains
    .map((domain) => getExpiryTimestamp(domain))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)[0];
  const bExpiry = b.allDomains
    .map((domain) => getExpiryTimestamp(domain))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)[0];
  const result = compareNullableNumbers(aExpiry ?? null, bExpiry ?? null, sortDirection);
  return result !== 0 ? result : compareStrings(a.key, b.key, "asc");
}

function buildDomainGroups(
  domains: Domain[],
  sortBy: SortBy,
  sortDirection: SortDirection,
): DomainGroup[] {
  const grouped = new Map<string, Domain[]>();

  for (const domain of domains) {
    const key = getBaseDomain(domain.domain);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(domain);
  }

  return [...grouped.entries()]
    .map(([key, entries]) => {
      const sortedEntries = [...entries].sort((left, right) =>
        compareDomains(left, right, sortBy, sortDirection),
      );
      const rootDomain =
        sortedEntries.find((domain) => getDomainHost(domain.domain) === key) ?? null;
      const childDomains = sortedEntries.filter((domain) => domain.id !== rootDomain?.id);

      return {
        key,
        rootDomain,
        childDomains,
        allDomains: rootDomain ? [rootDomain, ...childDomains] : childDomains,
      };
    })
    .sort((left, right) => compareGroups(left, right, sortBy, sortDirection));
}

function getExpiryProgress(domain: Domain): number {
  const daysLeft = getDaysUntilExpiry(domain);
  if (daysLeft === null) {
    return 8;
  }
  if (daysLeft <= 0) {
    return 100;
  }
  return Math.max(8, Math.min(100, Math.round(((90 - Math.min(daysLeft, 90)) / 90) * 100)));
}

function getGroupStats(domains: Domain[]) {
  const statuses = domains.map(getStatusMeta);
  const expiringSoon = domains.filter((domain) => {
    const daysLeft = getDaysUntilExpiry(domain);
    return daysLeft !== null && daysLeft >= 0 && daysLeft <= 30;
  }).length;
  const errors = statuses.filter((status) => status.key === "error").length;
  const expired = statuses.filter((status) => status.key === "expired").length;
  const minDays = domains
    .map(getDaysUntilExpiry)
    .filter((days): days is number => days !== null)
    .sort((left, right) => left - right)[0];

  return {
    expiringSoon,
    errors,
    expired,
    minDays: minDays ?? null,
    risk:
      statuses.sort((left, right) => left.priority - right.priority)[0] ??
      getStatusMeta(domains[0]),
  };
}

function defaultSortDirection(sortBy: SortBy): SortDirection {
  return sortBy === "lastChecked" || sortBy === "created" || sortBy === "notesLength"
    ? "desc"
    : "asc";
}

function SortIcon({ active, direction }: { active: boolean; direction: SortDirection }) {
  if (!active) {
    return <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />;
  }
  return direction === "asc" ? (
    <ArrowUp className="h-3.5 w-3.5" />
  ) : (
    <ArrowDown className="h-3.5 w-3.5" />
  );
}

export default function DashboardPage() {
  useDocumentTitle("Dashboard");
  const { user, logout } = useAuth();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [sortBy, setSortBy] = useState<SortBy>("expiry");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>("all");
  const [checkedFilter, setCheckedFilter] = useState<CheckedFilter>("all");
  const [notesFilter, setNotesFilter] = useState<NotesFilter>("all");
  const [domainTypeFilter, setDomainTypeFilter] = useState<DomainTypeFilter>("all");
  const [issuerFilter, setIssuerFilter] = useState("all");
  const [baseDomainFilter, setBaseDomainFilter] = useState("all");
  const [groupMode, setGroupMode] = useState<GroupMode>("base");
  const [loading, setLoading] = useState(true);
  const [newDomain, setNewDomain] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [addError, setAddError] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editNotes, setEditNotes] = useState("");
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(() => new Set());
  const [testEmailLoading, setTestEmailLoading] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [testEmailResult, setTestEmailResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [configActionResult, setConfigActionResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [domainActionResult, setDomainActionResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [emailHistory, setEmailHistory] = useState<EmailHistoryItem[]>([]);
  const [emailSummary, setEmailSummary] = useState<EmailHistorySummary | null>(null);
  const [emailHistoryLoading, setEmailHistoryLoading] = useState(true);
  const [emailSettings, setEmailSettings] = useState<NotificationSettings | null>(null);
  const [thresholdInput, setThresholdInput] = useState("");
  const [upcomingEmails, setUpcomingEmails] = useState<UpcomingEmailPlan[]>([]);
  const [nextEmailRunAt, setNextEmailRunAt] = useState<string | null>(null);
  const [upcomingEmailNote, setUpcomingEmailNote] = useState<string | null>(null);
  const [emailScheduleLoading, setEmailScheduleLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [selectedUpcomingEmail, setSelectedUpcomingEmail] = useState<UpcomingEmailPlan | null>(
    null,
  );
  const modalCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusedElementRef = useRef<HTMLElement | null>(null);
  const [showEmailDebug, setShowEmailDebug] = useState(() =>
    window.location.hash.includes("debug-email"),
  );
  const filterLabelClass =
    "mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500";
  const filterSelectClass =
    "h-11 w-full appearance-none rounded-2xl border border-slate-200 bg-white px-4 pr-10 text-sm text-slate-800 outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-200";
  const filterCaretClass =
    "pointer-events-none absolute inset-y-0 right-3 flex items-center text-slate-400";

  const fetchDomains = useCallback(async () => {
    try {
      const data = await api.get<{ domains: Domain[] }>("/domains");
      setDomains(data.domains);
    } catch (err) {
      console.error("Failed to fetch domains:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchEmailHistory = useCallback(async () => {
    setEmailHistoryLoading(true);
    try {
      const data = await api.get<{ emails: EmailHistoryItem[]; summary: EmailHistorySummary }>(
        "/email/history?limit=20",
      );
      setEmailHistory(data.emails);
      setEmailSummary(data.summary);
    } catch (err) {
      console.error("Failed to fetch email history:", err);
    } finally {
      setEmailHistoryLoading(false);
    }
  }, []);

  const fetchNotificationSettings = useCallback(async () => {
    try {
      const data = await api.get<{ settings: NotificationSettings }>("/email/settings");
      setEmailSettings(data.settings);
      setThresholdInput(data.settings.userThresholdDays?.toString() ?? "");
    } catch (err) {
      console.error("Failed to fetch notification settings:", err);
    }
  }, []);

  const fetchEmailSchedule = useCallback(async () => {
    setEmailScheduleLoading(true);
    try {
      const data = await api.get<UpcomingEmailResponse>("/email/upcoming");
      setEmailSettings(data.settings);
      setThresholdInput(data.settings.userThresholdDays?.toString() ?? "");
      setUpcomingEmails(data.emails);
      setNextEmailRunAt(data.nextRunAt);
      setUpcomingEmailNote(data.note);
    } catch (err) {
      console.error("Failed to fetch upcoming email schedule:", err);
    } finally {
      setEmailScheduleLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDomains();
  }, [fetchDomains]);

  useEffect(() => {
    fetchNotificationSettings();
  }, [fetchNotificationSettings]);

  useEffect(() => {
    if (!showEmailDebug) {
      return;
    }
    fetchEmailHistory();
  }, [fetchEmailHistory, showEmailDebug]);

  useEffect(() => {
    if (!showEmailDebug) {
      return;
    }
    fetchEmailSchedule();
  }, [fetchEmailSchedule, showEmailDebug]);

  useEffect(() => {
    const syncDebugEmail = () => {
      setShowEmailDebug(window.location.hash.includes("debug-email"));
    };

    syncDebugEmail();
    window.addEventListener("hashchange", syncDebugEmail);
    return () => window.removeEventListener("hashchange", syncDebugEmail);
  }, []);

  useEffect(() => {
    if (!selectedUpcomingEmail) {
      previousFocusedElementRef.current?.focus();
      return;
    }

    previousFocusedElementRef.current = document.activeElement as HTMLElement | null;
    modalCloseButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedUpcomingEmail(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedUpcomingEmail]);

  const handleAddDomain = async (e: FormEvent) => {
    e.preventDefault();
    setAddError("");
    setAddLoading(true);
    try {
      await api.post("/domains", { domain: newDomain, notes: newNotes || null });
      setNewDomain("");
      setNewNotes("");
      setShowAddForm(false);
      await fetchDomains();
      await fetchNotificationSettings();
      if (showEmailDebug) {
        await fetchEmailSchedule();
      }
    } catch (err: unknown) {
      setAddError(getErrorMessage(err, "Failed to add domain"));
    } finally {
      setAddLoading(false);
    }
  };

  const handleDeleteDomain = async (id: number) => {
    if (!confirm("Remove this domain from monitoring?")) return;
    try {
      await api.delete(`/domains/${id}`);
      await fetchDomains();
      await fetchNotificationSettings();
      if (showEmailDebug) {
        await fetchEmailSchedule();
      }
      setDomainActionResult({ type: "success", message: "Domain removed from monitoring." });
    } catch (err: unknown) {
      setDomainActionResult({
        type: "error",
        message: getErrorMessage(err, "Failed to delete domain"),
      });
    }
  };

  const handleCheckDomain = async (id: number) => {
    setCheckingId(id);
    try {
      await api.post(`/domains/${id}/check`);
      await fetchDomains();
      await fetchNotificationSettings();
      if (showEmailDebug) {
        await fetchEmailSchedule();
      }
      setDomainActionResult({ type: "success", message: "Certificate check completed." });
    } catch (err: unknown) {
      setDomainActionResult({
        type: "error",
        message: getErrorMessage(err, "Failed to check domain"),
      });
    } finally {
      setCheckingId(null);
    }
  };

  const handleRefreshAllDomains = async () => {
    setRefreshingAll(true);
    try {
      await api.post("/domains/check-all");
      await fetchDomains();
      await fetchNotificationSettings();
      if (showEmailDebug) {
        await fetchEmailSchedule();
      }
      setDomainActionResult({
        type: "success",
        message: "Certificate checks completed for all monitored domains.",
      });
    } catch (err: unknown) {
      setDomainActionResult({
        type: "error",
        message: getErrorMessage(err, "Failed to refresh all domains"),
      });
    } finally {
      setRefreshingAll(false);
    }
  };

  const handleUpdateNotes = async (id: number) => {
    try {
      await api.put(`/domains/${id}`, { notes: editNotes || null });
      setEditingId(null);
      await fetchDomains();
      await fetchNotificationSettings();
      if (showEmailDebug) {
        await fetchEmailSchedule();
      }
      setDomainActionResult({ type: "success", message: "Renewal notes updated." });
    } catch (err: unknown) {
      setDomainActionResult({
        type: "error",
        message: getErrorMessage(err, "Failed to update notes"),
      });
    }
  };

  const handleTestEmail = async () => {
    setTestEmailLoading(true);
    setTestEmailResult(null);
    try {
      await api.post("/email/test");
      await fetchEmailHistory();
      setTestEmailResult({ type: "success", message: "Test email sent successfully." });
    } catch (err: unknown) {
      await fetchEmailHistory();
      setTestEmailResult({
        type: "error",
        message: getErrorMessage(err, "Failed to send test email"),
      });
    } finally {
      setTestEmailLoading(false);
    }
  };

  const saveNotificationThreshold = async (value: number | null) => {
    setSettingsSaving(true);
    setConfigActionResult(null);
    try {
      const data = await api.put<{ settings: NotificationSettings }>("/email/settings", {
        notificationThresholdDays: value,
      });
      setEmailSettings(data.settings);
      setThresholdInput(data.settings.userThresholdDays?.toString() ?? "");
      if (showEmailDebug) {
        await fetchEmailSchedule();
      }
      setConfigActionResult({
        type: "success",
        message:
          data.settings.userThresholdDays === null
            ? `Using the admin default ${data.settings.adminDefaultThresholdDays}-day notification window.`
            : `Using your ${data.settings.userThresholdDays}-day notification window.`,
      });
    } catch (err: unknown) {
      setConfigActionResult({
        type: "error",
        message: getErrorMessage(err, "Failed to save notification settings"),
      });
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleSaveNotificationThreshold = async () => {
    const trimmed = thresholdInput.trim();
    if (!trimmed) {
      await saveNotificationThreshold(null);
      return;
    }

    const parsed = Number.parseInt(trimmed, 10);
    const min = emailSettings?.minThresholdDays ?? 1;
    const max = emailSettings?.maxThresholdDays ?? 365;

    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      setConfigActionResult({
        type: "error",
        message: `Enter a whole number between ${min} and ${max} days.`,
      });
      return;
    }

    await saveNotificationThreshold(parsed);
  };

  const handleExportConfig = async () => {
    setExportLoading(true);
    setConfigActionResult(null);
    try {
      const data = await api.get<ConfigExportPayload>("/config/export");
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const safeEmail = (user?.email || "user").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      const date = new Date().toISOString().slice(0, 10);

      anchor.href = url;
      anchor.download = `cert-expire-notifier-config-${safeEmail}-${date}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      setConfigActionResult({
        type: "success",
        message: `Exported ${data.domains.length} domain configuration${data.domains.length === 1 ? "" : "s"}.`,
      });
    } catch (err: unknown) {
      setConfigActionResult({
        type: "error",
        message: getErrorMessage(err, "Failed to export configuration"),
      });
    } finally {
      setExportLoading(false);
    }
  };

  const handleImportClick = () => {
    importInputRef.current?.click();
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    if (
      !confirm(
        "This will replace your current monitored domains and notes with the uploaded configuration. Continue?",
      )
    ) {
      return;
    }

    setImportLoading(true);
    setConfigActionResult(null);

    try {
      const text = await file.text();
      const payload = JSON.parse(text) as unknown;
      const data = await api.post<{ message: string; importedDomains: number }>(
        "/config/import",
        payload,
      );
      await fetchDomains();
      await fetchNotificationSettings();
      if (showEmailDebug) {
        await fetchEmailSchedule();
      }
      setShowAddForm(false);
      setConfigActionResult({
        type: "success",
        message: data.message,
      });
    } catch (err: unknown) {
      const message =
        err instanceof SyntaxError
          ? "Invalid JSON file"
          : getErrorMessage(err, "Failed to import configuration");
      setConfigActionResult({
        type: "error",
        message,
      });
    } finally {
      setImportLoading(false);
    }
  };

  const issuerOptions = useMemo(
    () =>
      [
        ...new Set(
          domains.map((domain) => domain.certIssuer).filter((issuer): issuer is string => !!issuer),
        ),
      ].sort(),
    [domains],
  );

  const baseDomainOptions = useMemo(
    () => [...new Set(domains.map((domain) => getBaseDomain(domain.domain)))].sort(),
    [domains],
  );

  const filteredDomains = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return domains
      .filter((domain) => {
        const baseDomain = getBaseDomain(domain.domain);
        const searchable = [
          domain.domain,
          baseDomain,
          domain.certIssuer,
          domain.certError,
          domain.notes,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const queryMatch = !normalizedQuery || searchable.includes(normalizedQuery);
        const issuerMatch = issuerFilter === "all" || domain.certIssuer === issuerFilter;
        const baseMatch = baseDomainFilter === "all" || baseDomain === baseDomainFilter;
        const notesMatch =
          notesFilter === "all" ||
          (notesFilter === "with" && !!domain.notes?.trim()) ||
          (notesFilter === "without" && !domain.notes?.trim());
        const typeMatch =
          domainTypeFilter === "all" ||
          (domainTypeFilter === "root" && isRootDomain(domain)) ||
          (domainTypeFilter === "subdomain" && !isRootDomain(domain));

        return (
          queryMatch &&
          issuerMatch &&
          baseMatch &&
          notesMatch &&
          typeMatch &&
          statusMatches(domain, statusFilter) &&
          expiryMatches(domain, expiryFilter) &&
          checkedMatches(domain, checkedFilter)
        );
      })
      .sort((left, right) => compareDomains(left, right, sortBy, sortDirection));
  }, [
    baseDomainFilter,
    checkedFilter,
    domainTypeFilter,
    domains,
    expiryFilter,
    issuerFilter,
    notesFilter,
    query,
    sortBy,
    sortDirection,
    statusFilter,
  ]);

  const domainGroups = useMemo(
    () => buildDomainGroups(filteredDomains, sortBy, sortDirection),
    [filteredDomains, sortBy, sortDirection],
  );

  const effectiveAlertWindow = emailSettings?.effectiveThresholdDays ?? 30;

  const dashboardStats = useMemo(() => {
    const statuses = domains.map(getStatusMeta);
    const checkedCount = domains.filter((domain) => domain.lastCheckedAt).length;
    const expiringCount = domains.filter((domain) => {
      const daysLeft = getDaysUntilExpiry(domain);
      return daysLeft !== null && daysLeft >= 0 && daysLeft <= effectiveAlertWindow;
    }).length;
    const errorCount = statuses.filter((status) => status.key === "error").length;
    const expiredCount = statuses.filter((status) => status.key === "expired").length;
    const criticalCount = statuses.filter((status) => status.key === "critical").length;
    const unknownCount = statuses.filter((status) => status.key === "unknown").length;
    const minDays = domains
      .map(getDaysUntilExpiry)
      .filter((days): days is number => days !== null)
      .sort((left, right) => left - right)[0];
    const latestCheck = domains
      .map(getLastCheckedTimestamp)
      .filter((timestamp): timestamp is number => timestamp !== null)
      .sort((left, right) => right - left)[0];

    return {
      checkedCount,
      criticalCount,
      errorCount,
      expiredCount,
      expiringCount,
      latestCheck: latestCheck ? new Date(latestCheck).toISOString() : null,
      minDays: minDays ?? null,
      unknownCount,
    };
  }, [domains, effectiveAlertWindow]);

  const hasActiveFilters =
    query.trim() !== "" ||
    statusFilter !== "all" ||
    expiryFilter !== "all" ||
    checkedFilter !== "all" ||
    notesFilter !== "all" ||
    domainTypeFilter !== "all" ||
    issuerFilter !== "all" ||
    baseDomainFilter !== "all";

  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setExpiryFilter("all");
    setCheckedFilter("all");
    setNotesFilter("all");
    setDomainTypeFilter("all");
    setIssuerFilter("all");
    setBaseDomainFilter("all");
  };

  const updateSort = (nextSort: SortBy) => {
    if (sortBy === nextSort) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(nextSort);
    setSortDirection(defaultSortDirection(nextSort));
  };

  const toggleExpandedNotes = (id: number) => {
    setExpandedNotes((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const renderAlert = (
    result: { type: "success" | "error"; message: string },
    onDismiss: () => void,
  ) => (
    <div className="mx-auto max-w-[1500px] px-4 pt-3 sm:px-6 lg:px-8">
      <div
        className={`flex items-center justify-between rounded-2xl border px-4 py-3 text-sm shadow-sm ${
          result.type === "success"
            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border-rose-200 bg-rose-50 text-rose-700"
        }`}
      >
        <span>{result.message}</span>
        <button
          onClick={onDismiss}
          className="rounded-full p-1 hover:bg-white/70"
          aria-label="Dismiss alert"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  const renderEmailStatusPill = (status: EmailStatus) => (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${emailStatusTones[status]}`}
    >
      {emailStatusLabels[status]}
    </span>
  );

  const renderStatusPill = (domain: Domain) => {
    const status = getStatusMeta(domain);
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-semibold ${status.tone}`}
      >
        {status.icon}
        {status.label}
      </span>
    );
  };

  const renderSortButton = (label: string, field: SortBy, className = "") => (
    <button
      type="button"
      onClick={() => updateSort(field)}
      className={`inline-flex items-center gap-1 text-left font-semibold text-slate-600 transition hover:text-slate-950 ${className}`}
    >
      {label}
      <SortIcon active={sortBy === field} direction={sortDirection} />
    </button>
  );

  const renderDomainRows = (rows: Domain[]) =>
    rows.map((domain) => {
      const status = getStatusMeta(domain);
      const baseDomain = getBaseDomain(domain.domain);
      const daysLeft = getDaysUntilExpiry(domain);
      const checkedAge = getAgeInDays(domain.lastCheckedAt);
      const noteText = domain.notes ? stripMarkdown(domain.notes) : "";
      const notesExpanded = expandedNotes.has(domain.id);
      const isEditing = editingId === domain.id;

      return (
        <tbody key={domain.id} className="divide-y divide-slate-100">
          <tr className="group bg-white/85 transition hover:bg-slate-50/90">
            <td className="px-4 py-2.5 align-top">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <span className={`h-2.5 w-2.5 flex-none rounded-full ${status.dot}`} />
                  <span className="truncate font-semibold text-slate-950">{domain.domain}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-[1.375rem] text-xs text-slate-500">
                  <span>{baseDomain}</span>
                  <span>Added {formatDate(domain.createdAt)}</span>
                </div>
              </div>
            </td>
            <td className="px-3 py-2.5 align-top">
              <div className="flex flex-wrap items-center gap-1.5">
                {renderStatusPill(domain)}
                {domain.lastIpResults?.length ? (
                  <IpCertificatesBadge
                    results={domain.lastIpResults}
                    earliestIp={domain.certIp}
                    domain={domain.domain}
                    needsAttention={status.key !== "healthy"}
                  />
                ) : null}
              </div>
            </td>
            <td className="px-3 py-2.5 align-top">
              <div className={`font-semibold ${getExpiryColor(domain.certExpiresAt)}`}>
                {domain.certExpiresAt ? formatRelativeDate(domain.certExpiresAt) : "Expiry unknown"}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {domain.certExpiresAt
                  ? formatDate(domain.certExpiresAt)
                  : "No certificate data yet"}
              </div>
              {domain.certIp ? (
                <div className="mt-1 break-all text-[11px] text-slate-500">
                  Earliest: <span className="font-mono">{domain.certIp}</span>
                </div>
              ) : null}
              <div className="mt-2 h-1.5 rounded-full bg-slate-100">
                <div
                  className={`h-1.5 rounded-full ${status.dot}`}
                  style={{ width: `${getExpiryProgress(domain)}%` }}
                />
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {daysLeft === null
                  ? "Run a check to populate expiry"
                  : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
              </div>
            </td>
            <td className="px-3 py-2.5 align-top">
              <div className="whitespace-nowrap font-medium tabular-nums text-slate-800">
                {domain.lastCheckedAt ? formatDate(domain.lastCheckedAt) : "Never checked"}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {checkedAge === null
                  ? "Pending first scan"
                  : checkedAge <= 1
                    ? "Fresh"
                    : `${checkedAge} days old`}
              </div>
            </td>
            <td className="px-3 py-2.5 align-top">
              <div className="line-clamp-2 text-sm text-slate-700">
                {domain.certIssuer || "Unknown issuer"}
              </div>
              {domain.certError ? (
                <div title={domain.certError} className="mt-1 line-clamp-2 text-xs text-rose-600">
                  {domain.certError}
                </div>
              ) : null}
            </td>
            <td className="px-3 py-2.5 align-top">
              {noteText ? (
                <button
                  type="button"
                  onClick={() => toggleExpandedNotes(domain.id)}
                  className="line-clamp-2 text-left text-sm text-slate-700 hover:text-slate-950"
                  aria-label={`Expand notes for ${domain.domain}`}
                >
                  {noteText}
                </button>
              ) : (
                <span className="text-sm text-slate-400">No notes</span>
              )}
            </td>
            <td className="whitespace-nowrap px-3 py-2.5 text-right align-top">
              <div className="flex justify-end gap-1">
                <button
                  onClick={() => {
                    setEditingId(domain.id);
                    setEditNotes(domain.notes || "");
                  }}
                  className="rounded-lg border border-transparent p-2 text-slate-500 transition hover:border-slate-200 hover:bg-white hover:text-slate-950"
                  aria-label={`Edit notes for ${domain.domain}`}
                >
                  <Edit3 className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handleCheckDomain(domain.id)}
                  disabled={checkingId === domain.id}
                  className="rounded-lg border border-transparent p-2 text-slate-500 transition hover:border-slate-200 hover:bg-white hover:text-slate-950 disabled:opacity-50"
                  aria-label={`Check certificate for ${domain.domain}`}
                >
                  <RefreshCw
                    className={`h-4 w-4 ${checkingId === domain.id ? "animate-spin" : ""}`}
                  />
                </button>
                <button
                  onClick={() => handleDeleteDomain(domain.id)}
                  className="rounded-lg border border-transparent p-2 text-slate-500 transition hover:border-rose-100 hover:bg-rose-50 hover:text-rose-600"
                  aria-label={`Remove ${domain.domain} from monitoring`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </td>
          </tr>
          {isEditing ? (
            <tr className="bg-slate-50/80">
              <td colSpan={7} className="px-3 py-3">
                <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">Edit renewal notes</p>
                      <p className="text-xs text-slate-500">
                        Markdown is supported. Keep runbooks close to the certificate row.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleUpdateNotes(domain.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-slate-800"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                      >
                        <X className="h-3.5 w-3.5" />
                        Cancel
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    rows={5}
                    className="block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm shadow-inner outline-none transition focus:border-slate-400 focus:bg-white focus:ring-4 focus:ring-slate-200/70"
                    placeholder="Renewal steps, owner, rotation notes, escalation contacts..."
                  />
                </div>
              </td>
            </tr>
          ) : null}
          {!isEditing && notesExpanded && domain.notes ? (
            <tr className="bg-slate-50/80">
              <td colSpan={7} className="px-3 py-3">
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="inline-flex items-center gap-2 text-sm font-semibold text-slate-950">
                      <FileText className="h-4 w-4" />
                      Notes for {domain.domain}
                    </div>
                    <button
                      onClick={() => toggleExpandedNotes(domain.id)}
                      className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      aria-label={`Close notes for ${domain.domain}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="prose prose-sm max-w-none text-slate-700 prose-headings:text-slate-950 prose-a:text-slate-950 prose-code:text-slate-950">
                    <ReactMarkdown>{domain.notes}</ReactMarkdown>
                  </div>
                </div>
              </td>
            </tr>
          ) : null}
        </tbody>
      );
    });

  const renderInventoryTable = (rows: Domain[]) => (
    <div className="overflow-x-auto">
      <table className="min-w-[1080px] w-full table-fixed border-separate border-spacing-0 text-sm">
        <colgroup>
          <col className="w-[19%]" />
          <col className="w-[8%]" />
          <col className="w-[15%]" />
          <col className="w-[13%]" />
          <col className="w-[20%]" />
          <col className="w-[18%]" />
          <col className="w-[7%]" />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-slate-50/95 text-xs uppercase tracking-wide text-slate-500 backdrop-blur">
          <tr>
            <th className="border-b border-slate-200 px-3 py-3 text-left">
              {renderSortButton("Domain", "domain")}
            </th>
            <th className="border-b border-slate-200 px-3 py-3 text-left">
              {renderSortButton("Status", "status")}
            </th>
            <th className="border-b border-slate-200 px-3 py-3 text-left">
              {renderSortButton("Expiry", "expiry")}
            </th>
            <th className="border-b border-slate-200 px-3 py-3 text-left">
              {renderSortButton("Checked", "lastChecked")}
            </th>
            <th className="border-b border-slate-200 px-3 py-3 text-left">
              {renderSortButton("Issuer", "issuer")}
            </th>
            <th className="border-b border-slate-200 px-3 py-3 text-left">
              {renderSortButton("Notes", "notesLength")}
            </th>
            <th className="border-b border-slate-200 px-3 py-3 text-right">Actions</th>
          </tr>
        </thead>
        {renderDomainRows(rows)}
      </table>
    </div>
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/10 px-5 py-4 shadow-2xl backdrop-blur">
          <RefreshCw className="h-5 w-5 animate-spin" />
          <span className="text-sm font-medium">Loading certificate inventory...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-slate-950/95 text-white shadow-2xl backdrop-blur supports-[backdrop-filter]:bg-slate-950/85">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-3 px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-400/15 ring-1 ring-cyan-300/20">
              <Shield className="h-6 w-6 text-cyan-200" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight">Cert Expire Notifier</h1>
                <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-cyan-100">
                  Command center
                </span>
              </div>
              <p className="text-xs text-slate-300">
                Dense SSL inventory, renewal runbooks, and notification controls.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleImportFile}
              className="hidden"
            />
            <button
              onClick={handleRefreshAllDomains}
              disabled={refreshingAll}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-100 transition hover:bg-white/10 disabled:opacity-50"
              title="Run certificate checks for all monitored domains now"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshingAll ? "animate-spin" : ""}`} />
              {refreshingAll ? "Scanning" : "Refresh"}
            </button>
            <button
              onClick={handleExportConfig}
              disabled={exportLoading || importLoading}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-100 transition hover:bg-white/10 disabled:opacity-50"
              title="Download your current configuration as JSON"
            >
              <Download className="h-3.5 w-3.5" />
              {exportLoading ? "Exporting" : "Export"}
            </button>
            <button
              onClick={handleImportClick}
              disabled={importLoading || exportLoading}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-100 transition hover:bg-white/10 disabled:opacity-50"
              title="Upload a JSON backup to restore your configuration"
            >
              <Upload className="h-3.5 w-3.5" />
              {importLoading ? "Importing" : "Import"}
            </button>
            <button
              onClick={() => setNotificationsOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-100 transition hover:bg-white/10"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Notifications
            </button>
            <button
              onClick={handleTestEmail}
              disabled={testEmailLoading}
              className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-300 px-3 py-2 text-xs font-bold text-slate-950 shadow-lg shadow-cyan-950/30 transition hover:bg-cyan-200 disabled:opacity-50"
              title="Send a test email to verify your notification settings"
            >
              <Send className="h-3.5 w-3.5" />
              {testEmailLoading ? "Sending" : "Test email"}
            </button>
            <div className="hidden h-6 w-px bg-white/10 sm:block" />
            <span className="max-w-[220px] truncate text-xs text-slate-300">{user?.email}</span>
            <button
              onClick={logout}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs font-semibold text-slate-100 transition hover:bg-white/10"
            >
              <LogOut className="h-3.5 w-3.5" />
              Logout
            </button>
          </div>
        </div>
      </header>

      <NotificationsModal open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />

      {testEmailResult ? renderAlert(testEmailResult, () => setTestEmailResult(null)) : null}
      {domainActionResult
        ? renderAlert(domainActionResult, () => setDomainActionResult(null))
        : null}
      {configActionResult
        ? renderAlert(configActionResult, () => setConfigActionResult(null))
        : null}

      <main className="mx-auto max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8">
        <section className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <div className="rounded-3xl border border-white bg-white/90 p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Total</span>
              <Globe className="h-4 w-4 text-slate-400" />
            </div>
            <p className="mt-2 text-3xl font-black tracking-tight">{domains.length}</p>
            <p className="mt-1 text-xs text-slate-500">
              {pluralize(baseDomainOptions.length, "base domain")}
            </p>
          </div>
          <div className="rounded-3xl border border-orange-100 bg-white/90 p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-orange-600">
              <span>Critical</span>
              <AlertTriangle className="h-4 w-4" />
            </div>
            <p className="mt-2 text-3xl font-black tracking-tight text-orange-600">
              {dashboardStats.criticalCount}
            </p>
            <p className="mt-1 text-xs text-slate-500">within 7 days</p>
          </div>
          <div className="rounded-3xl border border-amber-100 bg-white/90 p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-amber-600">
              <span>Expiring</span>
              <CalendarClock className="h-4 w-4" />
            </div>
            <p className="mt-2 text-3xl font-black tracking-tight text-amber-600">
              {dashboardStats.expiringCount}
            </p>
            <p className="mt-1 text-xs text-slate-500">within {effectiveAlertWindow} days</p>
          </div>
          <div className="rounded-3xl border border-rose-100 bg-white/90 p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-rose-600">
              <span>Failures</span>
              <XCircle className="h-4 w-4" />
            </div>
            <p className="mt-2 text-3xl font-black tracking-tight text-rose-600">
              {dashboardStats.errorCount + dashboardStats.expiredCount}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {dashboardStats.errorCount} errors · {dashboardStats.expiredCount} expired
            </p>
          </div>
          <div className="rounded-3xl border border-emerald-100 bg-white/90 p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-emerald-600">
              <span>Checked</span>
              <Gauge className="h-4 w-4" />
            </div>
            <p className="mt-2 text-3xl font-black tracking-tight text-emerald-600">
              {dashboardStats.checkedCount}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              latest {dashboardStats.latestCheck ? formatDate(dashboardStats.latestCheck) : "never"}
            </p>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-slate-950 p-4 text-white shadow-sm">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-cyan-200">
              <span>Nearest</span>
              <Clock className="h-4 w-4" />
            </div>
            <p className="mt-2 text-3xl font-black tracking-tight">
              {dashboardStats.minDays === null ? "—" : dashboardStats.minDays}
            </p>
            <p className="mt-1 text-xs text-slate-300">
              days left · {dashboardStats.unknownCount} unknown
            </p>
          </div>
        </section>

        {showEmailDebug ? (
          <section className="mb-5 grid gap-4 xl:grid-cols-[0.78fr_1.22fr]">
            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-500">
                    <Send className="h-4 w-4" />
                    Email center
                  </div>
                  <h2 className="mt-2 text-xl font-black tracking-tight text-slate-950">
                    Notification schedule
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Preview the next certificate alert before the scheduled cron run sends it.
                  </p>
                </div>
                <span
                  className={`rounded-full border px-2 py-1 text-xs font-bold ${
                    user?.emailVerifiedAt
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-amber-200 bg-amber-50 text-amber-700"
                  }`}
                >
                  {user?.emailVerifiedAt ? "Verified" : "Email pending"}
                </span>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-2">
                <div className="rounded-2xl border border-cyan-100 bg-cyan-50 p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-cyan-700">
                    Upcoming
                  </p>
                  <p className="mt-1 text-2xl font-black text-cyan-700">{upcomingEmails.length}</p>
                  <p className="mt-1 text-[11px] text-cyan-700/75">planned alerts</p>
                </div>
                <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-emerald-700">Sent</p>
                  <p className="mt-1 text-2xl font-black text-emerald-700">
                    {emailSummary?.sent ?? 0}
                  </p>
                </div>
                <div className="rounded-2xl border border-rose-100 bg-rose-50 p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-rose-700">Failed</p>
                  <p className="mt-1 text-2xl font-black text-rose-700">
                    {emailSummary?.failed ?? 0}
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                    Skipped
                  </p>
                  <p className="mt-1 text-2xl font-black text-slate-700">
                    {emailSummary?.skipped ?? 0}
                  </p>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-black uppercase tracking-wide text-slate-500">
                      Alert window
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      Admin default: {emailSettings?.adminDefaultThresholdDays ?? 30} days ·
                      Effective:{" "}
                      <span className="font-black text-slate-950">
                        {emailSettings?.effectiveThresholdDays ?? 30} days
                      </span>
                    </p>
                  </div>
                  <span className="rounded-full bg-white px-2 py-1 text-[11px] font-bold text-slate-500 ring-1 ring-slate-200">
                    {emailSettings?.userThresholdDays === null ||
                    emailSettings?.userThresholdDays === undefined
                      ? "using default"
                      : "custom override"}
                  </span>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                  <input
                    type="number"
                    min={emailSettings?.minThresholdDays ?? 1}
                    max={emailSettings?.maxThresholdDays ?? 365}
                    value={thresholdInput}
                    onChange={(event) => setThresholdInput(event.target.value)}
                    className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-4 focus:ring-slate-200"
                    placeholder={`Leave blank for default (${emailSettings?.adminDefaultThresholdDays ?? 30})`}
                    aria-label="Override days before expiry notification"
                  />
                  <button
                    type="button"
                    onClick={handleSaveNotificationThreshold}
                    disabled={settingsSaving || emailScheduleLoading}
                    className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {settingsSaving ? "Saving" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => saveNotificationThreshold(null)}
                    disabled={
                      settingsSaving || emailScheduleLoading || !emailSettings?.userThresholdDays
                    }
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                  >
                    Use default
                  </button>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Leave the field blank to inherit the admin-managed default from
                  CERT_EXPIRY_THRESHOLD_DAYS.
                </p>
              </div>

              <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white">
                <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50 px-3 py-2">
                  <div>
                    <p className="text-xs font-black uppercase tracking-wide text-slate-500">
                      Upcoming certificate alert
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Next run {nextEmailRunAt ? formatDate(nextEmailRunAt) : "not calculated"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={fetchEmailSchedule}
                    disabled={emailScheduleLoading}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${emailScheduleLoading ? "animate-spin" : ""}`}
                    />
                    Refresh
                  </button>
                </div>

                {emailScheduleLoading ? (
                  <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-slate-500">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Calculating upcoming alert...
                  </div>
                ) : upcomingEmails.length === 0 ? (
                  <div className="px-4 py-8 text-sm text-slate-500">
                    <p className="font-semibold text-slate-700">
                      No expiry notification is currently planned.
                    </p>
                    <p className="mt-1">
                      {upcomingEmailNote ||
                        "Once a checked certificate falls inside your alert window, its email preview appears here."}
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {upcomingEmails.map((email) => (
                      <article key={`${email.toEmail}-${email.plannedFor}`} className="px-4 py-3">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <h3 className="text-sm font-black text-slate-950">{email.subject}</h3>
                            <p className="mt-1 text-xs text-slate-500">
                              To {email.toEmail} · planned {formatDate(email.plannedFor)} ·{" "}
                              {email.thresholdDays}-day window
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setSelectedUpcomingEmail(email)}
                            className="inline-flex items-center justify-center rounded-xl bg-slate-950 px-3 py-2 text-xs font-bold text-white hover:bg-slate-800"
                          >
                            View email
                          </button>
                        </div>
                        <p className="mt-2 line-clamp-2 text-xs text-slate-600">{email.preview}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {email.domains.slice(0, 5).map((domain) => (
                            <span
                              key={domain.domain}
                              className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-600"
                            >
                              {domain.domain} · {domain.daysUntilExpiry}d
                            </span>
                          ))}
                          {email.domains.length > 5 ? (
                            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-600">
                              +{email.domains.length - 5} more
                            </span>
                          ) : null}
                        </div>
                        {upcomingEmailNote ? (
                          <p className="mt-2 rounded-xl bg-cyan-50 px-3 py-2 text-xs text-cyan-800">
                            {upcomingEmailNote}
                          </p>
                        ) : null}
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/80 px-4 py-3 sm:px-5">
                <div>
                  <h2 className="text-sm font-black uppercase tracking-wide text-slate-500">
                    Past email list
                  </h2>
                  <p className="text-xs text-slate-500">
                    Showing latest {emailHistory.length} of {emailSummary?.total ?? 0} email events.
                  </p>
                </div>
                <button
                  onClick={fetchEmailHistory}
                  disabled={emailHistoryLoading}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${emailHistoryLoading ? "animate-spin" : ""}`}
                  />
                  Refresh
                </button>
              </div>

              {emailHistoryLoading ? (
                <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-slate-500">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Loading email history...
                </div>
              ) : emailHistory.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-slate-500">
                  No email events yet. Send a test email or wait for the next alert run.
                </div>
              ) : (
                <div className="max-h-[360px] divide-y divide-slate-100 overflow-auto">
                  {emailHistory.map((email) => (
                    <article key={email.id} className="px-4 py-3 sm:px-5">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            {renderEmailStatusPill(email.status)}
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                              {emailPurposeLabels[email.purpose]}
                            </span>
                          </div>
                          <h3 className="mt-2 truncate text-sm font-black text-slate-950">
                            {email.subject}
                          </h3>
                          <p className="mt-1 text-xs text-slate-500">
                            To {email.toEmail} · requested {formatDate(email.requestedAt)}
                            {email.sentAt ? ` · sent ${formatDate(email.sentAt)}` : ""}
                          </p>
                        </div>
                      </div>
                      {email.domains ? (
                        <p className="mt-2 line-clamp-1 text-xs text-slate-600">
                          Domains: {email.domains}
                        </p>
                      ) : email.preview ? (
                        <p className="mt-2 line-clamp-2 text-xs text-slate-600">{email.preview}</p>
                      ) : null}
                      {email.error ? (
                        <p className="mt-2 line-clamp-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">
                          {email.error}
                        </p>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        ) : null}

        <section className="mb-5 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 bg-gradient-to-r from-white via-slate-50 to-cyan-50/50 px-4 py-4 sm:px-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-500">
                  <SlidersHorizontal className="h-4 w-4" />
                  Control surface
                </div>
                <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
                  Monitored certificate inventory
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Showing {filteredDomains.length} of {domains.length} domains. Sort and filter
                  across status, issuer, root domain, recency, notes, and expiry windows.
                </p>
              </div>
              <button
                onClick={() => setShowAddForm((value) => !value)}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800"
              >
                <Plus className="h-4 w-4" />
                Add domain
              </button>
            </div>
          </div>

          {showAddForm ? (
            <form
              onSubmit={handleAddDomain}
              className="border-b border-slate-100 bg-slate-50/80 px-4 py-4 sm:px-5"
            >
              {addError ? (
                <div className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {addError}
                </div>
              ) : null}
              <div className="grid gap-3 lg:grid-cols-[minmax(220px,0.8fr)_minmax(320px,1.6fr)_auto] lg:items-start">
                <label className="block">
                  <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
                    Domain / port
                  </span>
                  <input
                    type="text"
                    required
                    value={newDomain}
                    onChange={(e) => setNewDomain(e.target.value)}
                    className="mt-1 block w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-200"
                    placeholder="api.example.com or api.example.com:443:192.0.2.10"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    To bypass DNS, use curl-style <code>hostname:port:ip</code>. The hostname is
                    still used for TLS/SNI.
                  </p>
                </label>
                <label className="block">
                  <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
                    Notes / renewal runbook
                  </span>
                  <textarea
                    value={newNotes}
                    onChange={(e) => setNewNotes(e.target.value)}
                    rows={3}
                    className="mt-1 block w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm shadow-sm outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-200"
                    placeholder="Owner, renewal command, DNS provider, escalation path..."
                  />
                </label>
                <div className="flex gap-2 lg:pt-6">
                  <button
                    type="submit"
                    disabled={addLoading}
                    className="rounded-2xl bg-cyan-300 px-4 py-2 text-sm font-black text-slate-950 shadow-sm hover:bg-cyan-200 disabled:opacity-50"
                  >
                    {addLoading ? "Adding" : "Add"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddForm(false);
                      setAddError("");
                    }}
                    className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </form>
          ) : null}

          <div className="grid gap-3 border-b border-slate-100 px-4 py-4 sm:px-5 xl:grid-cols-[minmax(260px,1.3fr)_repeat(5,minmax(150px,1fr))]">
            <label className="block xl:col-span-2">
              <span className={filterLabelClass}>Search</span>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-slate-400">
                  <Search className="h-4 w-4" />
                </div>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 pl-11 pr-4 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:bg-white focus:ring-4 focus:ring-slate-200/70"
                  placeholder="Search domain, issuer, notes, error..."
                />
              </div>
            </label>

            <label className="block">
              <span className={filterLabelClass}>Status</span>
              <div className="relative">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                  className={filterSelectClass}
                >
                  <option value="all">All statuses</option>
                  <option value="error">Connection errors</option>
                  <option value="expired">Expired</option>
                  <option value="critical">Critical ≤7d</option>
                  <option value="warning">Warning ≤30d</option>
                  <option value="healthy">Healthy</option>
                  <option value="unknown">Unknown</option>
                </select>
                <span className={filterCaretClass}>
                  <ChevronDown className="h-4 w-4" />
                </span>
              </div>
            </label>

            <label className="block">
              <span className={filterLabelClass}>Expiry</span>
              <div className="relative">
                <select
                  value={expiryFilter}
                  onChange={(e) => setExpiryFilter(e.target.value as ExpiryFilter)}
                  className={filterSelectClass}
                >
                  <option value="all">Any expiry</option>
                  <option value="expired">Expired</option>
                  <option value="today">Expires today</option>
                  <option value="7">Next 7 days</option>
                  <option value="30">Next 30 days</option>
                  <option value="90">Next 90 days</option>
                  <option value="valid">Valid &gt; 30 days</option>
                  <option value="unknown">Unknown</option>
                </select>
                <span className={filterCaretClass}>
                  <ChevronDown className="h-4 w-4" />
                </span>
              </div>
            </label>

            <label className="block">
              <span className={filterLabelClass}>Issuer</span>
              <div className="relative">
                <select
                  value={issuerFilter}
                  onChange={(e) => setIssuerFilter(e.target.value)}
                  className={filterSelectClass}
                >
                  <option value="all">Any issuer</option>
                  {issuerOptions.map((issuer) => (
                    <option key={issuer} value={issuer}>
                      {issuer}
                    </option>
                  ))}
                </select>
                <span className={filterCaretClass}>
                  <ChevronDown className="h-4 w-4" />
                </span>
              </div>
            </label>

            <label className="block">
              <span className={filterLabelClass}>Base domain</span>
              <div className="relative">
                <select
                  value={baseDomainFilter}
                  onChange={(e) => setBaseDomainFilter(e.target.value)}
                  className={filterSelectClass}
                >
                  <option value="all">Any base</option>
                  {baseDomainOptions.map((baseDomain) => (
                    <option key={baseDomain} value={baseDomain}>
                      {baseDomain}
                    </option>
                  ))}
                </select>
                <span className={filterCaretClass}>
                  <ChevronDown className="h-4 w-4" />
                </span>
              </div>
            </label>
          </div>

          <div className="grid gap-3 px-4 py-4 sm:px-5 lg:grid-cols-6">
            <label className="block">
              <span className={filterLabelClass}>Checked</span>
              <div className="relative">
                <select
                  value={checkedFilter}
                  onChange={(e) => setCheckedFilter(e.target.value as CheckedFilter)}
                  className={filterSelectClass}
                >
                  <option value="all">Any recency</option>
                  <option value="checked">Has check</option>
                  <option value="unchecked">Never checked</option>
                  <option value="24h">Fresh ≤24h</option>
                  <option value="7d">Fresh ≤7d</option>
                  <option value="stale">Stale / missing</option>
                </select>
                <span className={filterCaretClass}>
                  <ChevronDown className="h-4 w-4" />
                </span>
              </div>
            </label>
            <label className="block">
              <span className={filterLabelClass}>Notes</span>
              <div className="relative">
                <select
                  value={notesFilter}
                  onChange={(e) => setNotesFilter(e.target.value as NotesFilter)}
                  className={filterSelectClass}
                >
                  <option value="all">Any notes</option>
                  <option value="with">Has notes</option>
                  <option value="without">Missing notes</option>
                </select>
                <span className={filterCaretClass}>
                  <ChevronDown className="h-4 w-4" />
                </span>
              </div>
            </label>
            <label className="block">
              <span className={filterLabelClass}>Type</span>
              <div className="relative">
                <select
                  value={domainTypeFilter}
                  onChange={(e) => setDomainTypeFilter(e.target.value as DomainTypeFilter)}
                  className={filterSelectClass}
                >
                  <option value="all">Root + subdomain</option>
                  <option value="root">Root only</option>
                  <option value="subdomain">Subdomains only</option>
                </select>
                <span className={filterCaretClass}>
                  <ChevronDown className="h-4 w-4" />
                </span>
              </div>
            </label>
            <label className="block">
              <span className={filterLabelClass}>Group</span>
              <div className="relative">
                <select
                  value={groupMode}
                  onChange={(e) => setGroupMode(e.target.value as GroupMode)}
                  className={filterSelectClass}
                >
                  <option value="base">By base domain</option>
                  <option value="none">Flat table</option>
                </select>
                <span className={filterCaretClass}>
                  <ChevronDown className="h-4 w-4" />
                </span>
              </div>
            </label>
            <label className="block">
              <span className={filterLabelClass}>Sort by</span>
              <div className="relative">
                <select
                  value={sortBy}
                  onChange={(e) => {
                    const nextSort = e.target.value as SortBy;
                    setSortBy(nextSort);
                    setSortDirection(defaultSortDirection(nextSort));
                  }}
                  className={filterSelectClass}
                >
                  {Object.entries(sortLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <span className={filterCaretClass}>
                  <ChevronDown className="h-4 w-4" />
                </span>
              </div>
            </label>
            <div className="flex items-end gap-2">
              <button
                onClick={() => setSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
                className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-2xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                {sortDirection === "asc" ? (
                  <ArrowUp className="h-4 w-4" />
                ) : (
                  <ArrowDown className="h-4 w-4" />
                )}
                {sortDirection === "asc" ? "Asc" : "Desc"}
              </button>
              <button
                onClick={clearFilters}
                disabled={!hasActiveFilters}
                className="inline-flex h-11 items-center justify-center gap-1.5 rounded-2xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Filter className="h-4 w-4" />
                Clear
              </button>
            </div>
          </div>
        </section>

        {domains.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center shadow-sm">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-slate-100">
              <Globe className="h-8 w-8 text-slate-400" />
            </div>
            <h3 className="mt-4 text-lg font-black text-slate-950">No domains yet</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
              Add your first domain to begin tracking SSL expiry, issuer data, check freshness, and
              renewal notes.
            </p>
          </div>
        ) : filteredDomains.length === 0 ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-12 text-center shadow-sm">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-slate-100">
              <Search className="h-8 w-8 text-slate-400" />
            </div>
            <h3 className="mt-4 text-lg font-black text-slate-950">No matches</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
              Relax one or more filters to bring domains back into view.
            </p>
            <button
              onClick={clearFilters}
              className="mt-4 rounded-2xl bg-slate-950 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800"
            >
              Clear filters
            </button>
          </div>
        ) : groupMode === "none" ? (
          <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 sm:px-5">
              <div>
                <h3 className="text-sm font-black uppercase tracking-wide text-slate-500">
                  Flat inventory
                </h3>
                <p className="text-xs text-slate-500">
                  {pluralize(filteredDomains.length, "domain")} sorted by{" "}
                  {sortLabels[sortBy].toLowerCase()}
                </p>
              </div>
              <Layers className="h-5 w-5 text-slate-400" />
            </div>
            {renderInventoryTable(filteredDomains)}
          </section>
        ) : (
          <div className="space-y-4">
            {domainGroups.map((group) => {
              const groupStats = getGroupStats(group.allDomains);
              return (
                <section
                  key={group.key}
                  className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"
                >
                  <div className="flex flex-col gap-3 border-b border-slate-100 bg-slate-50/80 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                    <div className="flex items-start gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <div className={`h-3 w-3 rounded-full ${groupStats.risk.dot}`} />
                          <h3 className="text-base font-black text-slate-950">{group.key}</h3>
                          <span
                            className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${groupStats.risk.tone}`}
                          >
                            {groupStats.risk.label}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {pluralize(group.allDomains.length, "domain")} · {groupStats.expiringSoon}{" "}
                          expiring soon · {groupStats.errors} errors · nearest{" "}
                          {groupStats.minDays === null ? "unknown" : `${groupStats.minDays}d`}
                        </p>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center text-xs sm:min-w-[280px]">
                      <div className="rounded-2xl bg-white px-3 py-2 ring-1 ring-slate-200">
                        <div className="font-black text-slate-950">{group.childDomains.length}</div>
                        <div className="text-slate-500">subdomains</div>
                      </div>
                      <div className="rounded-2xl bg-white px-3 py-2 ring-1 ring-slate-200">
                        <div className="font-black text-amber-600">{groupStats.expiringSoon}</div>
                        <div className="text-slate-500">≤30d</div>
                      </div>
                      <div className="rounded-2xl bg-white px-3 py-2 ring-1 ring-slate-200">
                        <div className="font-black text-rose-600">
                          {groupStats.errors + groupStats.expired}
                        </div>
                        <div className="text-slate-500">issues</div>
                      </div>
                    </div>
                  </div>
                  {renderInventoryTable(group.allDomains)}
                </section>
              );
            })}
          </div>
        )}
      </main>

      {selectedUpcomingEmail ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 py-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Upcoming certificate alert preview"
        >
          <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
              <div className="min-w-0">
                <p className="text-xs font-black uppercase tracking-wide text-slate-500">
                  Planned email preview
                </p>
                <h2 className="mt-1 truncate text-lg font-black text-slate-950">
                  {selectedUpcomingEmail.subject}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  To {selectedUpcomingEmail.toEmail} · planned{" "}
                  {formatDate(selectedUpcomingEmail.plannedFor)}
                </p>
              </div>
              <button
                ref={modalCloseButtonRef}
                type="button"
                onClick={() => setSelectedUpcomingEmail(null)}
                className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close email preview"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="border-b border-slate-100 bg-slate-50 px-5 py-3 text-sm text-slate-600">
              {selectedUpcomingEmail.domains.length > 0
                ? `${pluralize(selectedUpcomingEmail.domains.length, "domain")} inside the ${selectedUpcomingEmail.thresholdDays}-day window.`
                : "No expiring certificates in this alert."}{" "}
              {selectedUpcomingEmail.failedDomains.length > 0
                ? `${pluralize(selectedUpcomingEmail.failedDomains.length, "failed check")} included.`
                : ""}
            </div>
            <iframe
              title="Upcoming certificate alert email body"
              sandbox=""
              srcDoc={selectedUpcomingEmail.html}
              className="h-[68vh] w-full flex-1 bg-white"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
