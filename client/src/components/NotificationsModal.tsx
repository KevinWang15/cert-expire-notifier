import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Mail, Plus, RefreshCw, Save, Webhook } from "lucide-react";
import type {
  NotificationHistoryEntry,
  NotificationSettings,
  WebhookMethod,
  WebhookTarget,
} from "@shared/types/notifications";
import { WEBHOOK_METHODS } from "@shared/types/notifications";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Modal } from "./Modal";

interface Props {
  open: boolean;
  onClose: () => void;
}
interface WebhookForm {
  id?: number;
  name: string;
  enabled: boolean;
  url: string;
  method: WebhookMethod;
  headers: string;
  bodyTemplate: string;
}
const emptyForm: WebhookForm = {
  name: "",
  enabled: true,
  url: "",
  method: "POST",
  headers: "{}",
  bodyTemplate: "",
};
const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50";
const inputClass =
  "mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

export function NotificationsModal({ open, onClose }: Props) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [entries, setEntries] = useState<NotificationHistoryEntry[]>([]);
  const [tab, setTab] = useState<"targets" | "history">("targets");
  const [form, setForm] = useState<WebhookForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const [nextSettings, history] = await Promise.all([
      api.get<NotificationSettings>("/notifications/settings"),
      api.get<{ entries: NotificationHistoryEntry[] }>("/notifications/history?limit=50"),
    ]);
    return { settings: nextSettings, entries: history.entries };
  }, []);

  const refresh = async () => {
    const data = await load();
    setSettings(data.settings);
    setEntries(data.entries);
  };

  useEffect(() => {
    if (!open) return;
    let active = true;
    void load()
      .then((data) => {
        if (active) {
          setSettings(data.settings);
          setEntries(data.entries);
        }
      })
      .catch((error) => {
        if (active) setError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [open, load]);

  const act = async (action: () => Promise<string>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setMessage(await action());
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      try {
        await refresh();
      } catch (error) {
        setError(errorMessage(error));
      }
      setBusy(false);
    }
  };

  const test = (id?: number) =>
    act(async () => {
      const result = await api.post<{ deliveries: { status: string }[] }>(
        id ? `/notifications/webhooks/${id}/test` : "/notifications/test",
      );
      const sent = result.deliveries.filter((delivery) => delivery.status === "SENT").length;
      const failed = result.deliveries.length - sent;
      return `Test delivered to ${sent} target${sent === 1 ? "" : "s"}.${failed ? ` ${failed} failed; see delivery history.` : ""}`;
    });

  const edit = (webhook: WebhookTarget) => {
    setError("");
    setMessage("");
    setForm({
      ...webhook,
      headers: JSON.stringify(webhook.headers, null, 2),
      bodyTemplate: webhook.bodyTemplate ?? "",
    });
  };

  const saveWebhook = (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    void act(async () => {
      let headers: unknown;
      try {
        headers = JSON.parse(form.headers);
      } catch {
        throw new Error("Headers must be a valid JSON object");
      }
      const payload = { ...form, headers, bodyTemplate: form.bodyTemplate || null };
      if (form.id) await api.put(`/notifications/webhooks/${form.id}`, payload);
      else await api.post("/notifications/webhooks", payload);
      setForm(null);
      return "Webhook saved.";
    });
  };

  const close = () => {
    setForm(null);
    setError("");
    setMessage("");
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Notifications"
      description="Configure delivery targets and view delivery history."
      size="lg"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2" role="tablist" aria-label="Notifications">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "targets"}
              className={`${buttonClass} ${tab === "targets" ? "bg-slate-100" : ""}`}
              onClick={() => setTab("targets")}
            >
              Targets
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "history"}
              className={`${buttonClass} ${tab === "history" ? "bg-slate-100" : ""}`}
              onClick={() => setTab("history")}
            >
              Delivery history
            </button>
          </div>
          <button
            type="button"
            disabled={busy || !settings}
            className={buttonClass}
            onClick={() => void test()}
          >
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}{" "}
            Send test to enabled targets
          </button>
        </div>
        {error || message ? (
          <p
            role="status"
            className={`rounded-md border p-3 text-sm ${error ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}
          >
            {error || message}
          </p>
        ) : null}
        {tab === "targets" ? (
          <div className="space-y-4">
            {!settings ? (
              <p className="text-sm text-slate-500">Loading targets…</p>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3 rounded-md border border-slate-200 p-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-semibold">
                      <Mail className="h-4 w-4" />
                      Email
                    </p>
                    <p className="mt-1 break-all text-sm text-slate-500">
                      {settings.email.address}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Verification and password reset messages always use email.
                    </p>
                  </div>
                  <label className="flex flex-none items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={settings.email.enabled}
                      disabled={busy}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        void act(async () => {
                          await api.put("/notifications/email", { enabled });
                          return `Email notifications ${enabled ? "enabled" : "disabled"}.`;
                        });
                      }}
                    />{" "}
                    Enabled
                  </label>
                </div>
                {settings.webhooks.map((webhook) => (
                  <div key={webhook.id} className="rounded-md border border-slate-200 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-semibold">
                          <Webhook className="h-4 w-4 flex-none" />
                          {webhook.name}
                        </p>
                        <p className="mt-1 break-all text-sm text-slate-500">
                          {webhook.method} · {webhook.url}
                        </p>
                      </div>
                      <label className="flex flex-none items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={webhook.enabled}
                          disabled={busy}
                          onChange={(event) => {
                            const enabled = event.target.checked;
                            void act(async () => {
                              await api.put(`/notifications/webhooks/${webhook.id}`, {
                                ...webhook,
                                enabled,
                              });
                              return "Webhook updated.";
                            });
                          }}
                        />{" "}
                        Enabled
                      </label>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={busy}
                        onClick={() => edit(webhook)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={busy}
                        onClick={() => void test(webhook.id)}
                      >
                        Send test
                      </button>
                      <button
                        type="button"
                        className={`${buttonClass} text-rose-600`}
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api.delete(`/notifications/webhooks/${webhook.id}`);
                            if (form?.id === webhook.id) setForm(null);
                            return "Webhook removed.";
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
                {!settings.email.enabled &&
                !settings.webhooks.some((webhook) => webhook.enabled) ? (
                  <p className="text-sm text-amber-700">
                    No targets are enabled for monitoring notifications.
                  </p>
                ) : null}
                {!form ? (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => setForm({ ...emptyForm })}
                  >
                    <Plus className="h-4 w-4" />
                    Add webhook
                  </button>
                ) : null}
              </>
            )}
            {form ? (
              <form
                onSubmit={saveWebhook}
                className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
              >
                <h3 className="font-semibold">{form.id ? "Edit webhook" : "Add webhook"}</h3>
                <label className="block text-sm font-semibold">
                  Name
                  <input
                    required
                    maxLength={191}
                    value={form.name}
                    className={inputClass}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                  />
                </label>
                <label className="block text-sm font-semibold">
                  URL
                  <input
                    required
                    type="url"
                    maxLength={2048}
                    value={form.url}
                    placeholder="https://example.com/webhook"
                    className={inputClass}
                    onChange={(event) => setForm({ ...form, url: event.target.value })}
                  />
                </label>
                <label className="block text-sm font-semibold">
                  HTTP method
                  <select
                    value={form.method}
                    className={inputClass}
                    onChange={(event) =>
                      setForm({ ...form, method: event.target.value as WebhookMethod })
                    }
                  >
                    {WEBHOOK_METHODS.map((method) => (
                      <option key={method}>{method}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-semibold">
                  Headers (JSON object)
                  <textarea
                    rows={3}
                    value={form.headers}
                    maxLength={16384}
                    spellCheck={false}
                    className={`${inputClass} font-mono`}
                    onChange={(event) => setForm({ ...form, headers: event.target.value })}
                  />
                </label>
                {form.method !== "GET" && form.method !== "HEAD" ? (
                  <label className="block text-sm font-semibold">
                    Body template (optional)
                    <textarea
                      rows={4}
                      value={form.bodyTemplate}
                      maxLength={65535}
                      placeholder={'{"text":"$SHORT_TEXT"}'}
                      spellCheck={false}
                      className={`${inputClass} font-mono`}
                      onChange={(event) => setForm({ ...form, bodyTemplate: event.target.value })}
                    />
                  </label>
                ) : null}
                <p className="text-xs leading-relaxed text-slate-500">
                  Leave the body blank to send JSON with subject, HTML, full text, shortText,
                  purpose, details, and timestamp. Templates support $SUBJECT, $TEXT, $SHORT_TEXT,
                  $HTML, $PURPOSE, $DETAILS, and $TIMESTAMP in the URL, headers, and body. JSON
                  string values are escaped automatically. URL substitutions are encoded as URL
                  components. GET and HEAD send no body.
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                  />
                  Enabled
                </label>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => setForm(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    <Save className="h-4 w-4" />
                    Save webhook
                  </button>
                </div>
              </form>
            ) : null}
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto">
            {entries.length === 0 ? (
              <p className="text-sm text-slate-500">No delivery history.</p>
            ) : (
              entries.map((entry) => (
                <div key={entry.id} className="rounded-md border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 break-words font-semibold text-slate-800">
                      {entry.subject}
                    </p>
                    <span className="flex-none rounded-md bg-slate-100 px-2 py-1 text-xs font-bold text-slate-600">
                      {entry.status}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-xs text-slate-500">
                    {formatDate(entry.requestedAt)} ·{" "}
                    {entry.channel === "EMAIL" ? "Email" : "Webhook"} · {entry.target}
                  </p>
                  {entry.preview ? (
                    <p className="mt-2 whitespace-pre-wrap break-words text-xs text-slate-600">
                      {entry.preview}
                    </p>
                  ) : null}
                  {entry.error ? (
                    <p className="mt-1 break-words text-xs text-rose-600">{entry.error}</p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
