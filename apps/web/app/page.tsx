"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";

type User = {
  id: string;
  tenantId: string | null;
  name: string;
  email: string;
  role: "master_admin" | "tenant_admin";
};

type Summary = {
  entriesToday: number;
  exitsToday: number;
  presentEmployees: number;
  absentEmployees: number;
  camerasOnline: number;
  recognitionsToday: number;
  recognitionsThirtyDays: number;
  recognitionsYear: number;
  employeeAttendance: Array<{
    id: string;
    fullName: string;
    onTimeEntries: number;
    lateEntries: number;
    exits: number;
  }>;
  latestDetections: Detection[];
  charts: {
    daily: ChartPoint[];
    monthly: ChartPoint[];
    yearly: ChartPoint[];
  };
};

type MasterSummary = {
  tenantCount: number;
  detectionCount: number;
  employeeCount: number;
  camerasOnline: number;
  activeClients: number;
};

type Tenant = {
  id: string;
  name: string;
  status: string;
  plan: string;
  subscriptionStatus: string;
  subscriptionDueDate?: string | null;
  employeeLimit: number;
  cameraLimit: number;
  adminName?: string | null;
  adminEmail?: string | null;
};

type Employee = {
  id: string;
  fullName: string;
  cpf?: string | null;
  registration?: string | null;
  phone?: string | null;
  department?: string | null;
  role?: string | null;
  workSchedule?: string | null;
  workDays: string[];
  entryTime?: string | null;
  exitTime?: string | null;
  toleranceMinutes: number;
  status: string;
  faceCount: number;
  recognitionFaceCount: number;
};

type Camera = {
  id: string;
  tenantId?: string;
  name: string;
  sourceType: "rtsp" | "rtmp" | "webcam";
  rtspUrl?: string | null;
  deviceIndex?: number | null;
  location: string;
  sector?: string | null;
  mode: "entry" | "exit" | "general";
  status: string;
};

type Detection = {
  id: string;
  detectedAt: string;
  eventType: string;
  confidence?: number | null;
  snapshotUrl?: string | null;
  camera: {
    id: string;
    name: string;
    location: string;
  };
  employee?: {
    id: string;
    fullName: string;
  } | null;
};

type AccessEvent = {
  id: string;
  eventType: string;
  occurredAt: string;
  confidence?: number | null;
  snapshotUrl?: string | null;
  employee: {
    id: string;
    fullName: string;
  };
  camera: {
    id: string;
    name: string;
    location: string;
  };
};

type PaginatedAccessEvents = {
  items: AccessEvent[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

type EventToast = {
  id: string;
  event: AccessEvent;
};

type AiStatus = {
  connected: boolean;
  cameraCount: number;
  faceCount: number;
  cameras: Array<{
    id: string;
    connected: boolean;
    faceCount: number;
    lastError?: string | null;
  }>;
};

type ChartPoint = {
  label: string;
  value: number;
};

type CameraTestResult = {
  connected: boolean;
  message: string;
  status: string;
};

type TelegramConnectLink = {
  link: string;
  botUsername: string;
};

type NotificationSettings = {
  notificationMode: "all_events" | "exceptions_only";
};

type NotificationContact = {
  id: string;
  name: string;
  status: string;
  connected: boolean;
  notifyTelegram: boolean;
  notifyEmail: boolean;
  email?: string | null;
  cameraIds: string[];
};

function normalizedBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function isLocalBrowserHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function defaultServiceUrl(service: "api" | "ai") {
  if (typeof window !== "undefined" && isLocalBrowserHost(window.location.hostname)) {
    return service === "api" ? "http://localhost:4000" : "http://localhost:8000";
  }

  return service === "api" ? "/api" : "/ai";
}

const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
const configuredAiUrl = process.env.NEXT_PUBLIC_AI_URL?.trim();
const apiUrl = normalizedBaseUrl(configuredApiUrl || defaultServiceUrl("api"));
const aiUrl = normalizedBaseUrl(configuredAiUrl || defaultServiceUrl("ai"));
const rtmpHost = process.env.NEXT_PUBLIC_RTMP_HOST;
const rtmpPort = process.env.NEXT_PUBLIC_RTMP_PORT ?? "1935";
const rtmpPathPrefix = process.env.NEXT_PUBLIC_RTMP_PATH_PREFIX ?? "";

async function jsonResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  const responseText = await response.text();
  let payload: { message?: string } & Record<string, unknown>;

  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    const serviceMessage =
      response.status >= 500
        ? "A API está temporariamente indisponível. Verifique o serviço facial-api na VPS."
        : "O servidor respondeu com uma página inválida no lugar da API.";
    throw new Error(`${serviceMessage} (HTTP ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(payload.message ?? `Erro ${response.status}`);
  }

  return payload as T;
}

async function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function eventLabel(type: string) {
  return (
    {
      entry: "Entrada",
      exit: "Saída",
      permanence: "Permanência",
      recognized_face: "Reconhecido",
      unknown_face: "Desconhecido"
    }[type] ?? type
  );
}

function isEntryOrExit(type: string) {
  return type === "entry" || type === "exit";
}

function isVideoPreview(url?: string | null) {
  return Boolean(url && /\.(mp4|webm|mov)(\?|$)/i.test(url));
}

function detectionMediaUrl(url?: string | null) {
  if (!url) {
    return null;
  }

  return url.replace(/^https?:\/\/(?:localhost|127\.0\.0\.1):8000/i, aiUrl);
}

function rtmpStreamKey(camera: Camera) {
  if (camera.sourceType !== "rtmp" || !camera.rtspUrl) {
    return null;
  }

  return camera.rtspUrl.split("/").filter(Boolean).at(-1) ?? null;
}

function rtmpPublishInfo(camera: Camera) {
  const streamKey = rtmpStreamKey(camera);

  if (!streamKey) {
    return null;
  }

  const host = rtmpHost || (typeof window === "undefined" ? "localhost" : window.location.hostname);
  const configuredPrefix = rtmpPathPrefix.trim().replace(/^\/+|\/+$/g, "");
  const publicPrefix = configuredPrefix || "live";
  const serverUrl = `rtmp://${host}:${rtmpPort}/${publicPrefix}`;

  return {
    streamKey,
    serverUrl,
    publishUrl: `${serverUrl}/${streamKey}`
  };
}

function DetectionPreview({
  url,
  label
}: {
  url?: string | null;
  label: string;
}) {
  if (!url) {
    return null;
  }

  const mediaUrl = detectionMediaUrl(url);
  if (!mediaUrl) {
    return null;
  }

  return (
    <a className="event-preview-link" href={mediaUrl} target="_blank" rel="noreferrer">
      {isVideoPreview(mediaUrl) ? (
        <video
          className="event-preview"
          src={mediaUrl}
          muted
          loop
          playsInline
          preload="metadata"
          onMouseEnter={(event) => event.currentTarget.play().catch(() => undefined)}
          onMouseLeave={(event) => {
            event.currentTarget.pause();
            event.currentTarget.currentTime = 0;
          }}
        />
      ) : (
        <img className="event-preview" src={mediaUrl} alt={label} />
      )}
      <span>Visualizar 3s</span>
    </a>
  );
}

export default function AppPage() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<
    "dashboard" | "employees" | "notifications" | "events" | "master"
  >("dashboard");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [masterSummary, setMasterSummary] = useState<MasterSummary | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [managedCameras, setManagedCameras] = useState<Camera[]>([]);
  const [accessEvents, setAccessEvents] = useState<AccessEvent[]>([]);
  const [accessEventsPage, setAccessEventsPage] = useState(1);
  const [accessEventsMeta, setAccessEventsMeta] = useState({
    totalItems: 0,
    totalPages: 1,
    pageSize: 10
  });
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings | null>(
    null
  );
  const [notificationContacts, setNotificationContacts] = useState<NotificationContact[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [eventToasts, setEventToasts] = useState<EventToast[]>([]);
  const knownAccessEventIds = useRef<Set<string>>(new Set());
  const accessEventsInitialized = useRef(false);

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {})
      }
    });

    return jsonResponse<T>(response);
  }

  function trackAccessEventNotifications(events: AccessEvent[]) {
    const knownIds = knownAccessEventIds.current;

    if (!accessEventsInitialized.current) {
      knownAccessEventIds.current = new Set(events.map((event) => event.id));
      accessEventsInitialized.current = true;
      return;
    }

    const newEvents = events
      .filter((event) => !knownIds.has(event.id))
      .filter((event) => isEntryOrExit(event.eventType))
      .sort(
        (left, right) =>
          new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime()
      );

    events.forEach((event) => knownIds.add(event.id));

    if (newEvents.length === 0) {
      return;
    }

    const newToasts = newEvents.map((event) => ({ id: `${event.id}-${Date.now()}`, event }));
    setEventToasts((current) => [...newToasts, ...current].slice(0, 4));

    newToasts.forEach((toast) => {
      window.setTimeout(() => {
        setEventToasts((current) => current.filter((item) => item.id !== toast.id));
      }, 9000);
    });
  }

  async function loadAll() {
    if (!token || !user) {
      return;
    }

    if (user.role === "master_admin") {
      const [loadedMasterSummary, loadedTenants, loadedAiStatus] = await Promise.all([
        api<MasterSummary>("/master/summary"),
        api<Tenant[]>("/tenants"),
        fetch(`${aiUrl}/status`).then((response) => response.json())
      ]);
      setMasterSummary(loadedMasterSummary);
      setTenants(loadedTenants);
      setAiStatus(loadedAiStatus);

      const tenantId = selectedTenantId ?? loadedTenants[0]?.id ?? null;
      setSelectedTenantId(tenantId);

      if (tenantId) {
        const loadedManagedCameras = await api<Camera[]>(`/cameras?tenantId=${tenantId}`);
        setManagedCameras(loadedManagedCameras);
      } else {
        setManagedCameras([]);
      }

      return;
    }

    const [
      loadedSummary,
      loadedEmployees,
      loadedCameras,
      loadedEvents,
      loadedSettings,
      loadedContacts,
      loadedAiStatus
    ] =
      await Promise.all([
        api<Summary>("/dashboard/summary"),
        api<Employee[]>("/employees"),
        api<Camera[]>("/cameras"),
        api<PaginatedAccessEvents>(`/access-events?page=${accessEventsPage}&pageSize=10`),
        api<NotificationSettings>("/notification-settings"),
        api<NotificationContact[]>("/notification-contacts"),
        fetch(`${aiUrl}/status`).then((response) => response.json())
      ]);

    setSummary(loadedSummary);
    setEmployees(loadedEmployees);
    setCameras(loadedCameras);
    trackAccessEventNotifications(loadedEvents.items);
    setAccessEvents(loadedEvents.items);
    setAccessEventsMeta({
      totalItems: loadedEvents.totalItems,
      totalPages: loadedEvents.totalPages,
      pageSize: loadedEvents.pageSize
    });
    setNotificationSettings(loadedSettings);
    setNotificationContacts(loadedContacts);
    setAiStatus(loadedAiStatus);

    setSelectedCameraId((currentCameraId) =>
      currentCameraId && loadedCameras.some((camera) => camera.id === currentCameraId)
        ? currentCameraId
        : loadedCameras[0]?.id ?? null
    );
  }

  useEffect(() => {
    const storedToken = window.localStorage.getItem("facial-token");
    const storedUser = window.localStorage.getItem("facial-user");

    if (storedToken && storedUser) {
      const parsedUser = JSON.parse(storedUser) as User;
      setToken(storedToken);
      setUser(parsedUser);
      if (parsedUser.role === "master_admin") {
        setActiveTab("master");
      }
    }
  }, []);

  useEffect(() => {
    if (!token || !user) {
      return;
    }

    loadAll().catch((error) => setMessage(error.message));
    const interval = window.setInterval(() => {
      loadAll().catch(() => undefined);
    }, 5000);

    return () => window.clearInterval(interval);
  }, [token, user, selectedTenantId, accessEventsPage]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    try {
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password")
        })
      });
      const payload = await jsonResponse<{ token: string; user: User }>(response);

      window.localStorage.setItem("facial-token", payload.token);
      window.localStorage.setItem("facial-user", JSON.stringify(payload.user));
      setToken(payload.token);
      setUser(payload.user);
      if (payload.user.role === "master_admin") {
        setActiveTab("master");
      } else {
        setActiveTab("dashboard");
      }
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha no login");
    }
  }

  function logout() {
    window.localStorage.removeItem("facial-token");
    window.localStorage.removeItem("facial-user");
    setToken(null);
    setUser(null);
    setSummary(null);
    setAccessEvents([]);
    setAccessEventsPage(1);
    setAccessEventsMeta({ totalItems: 0, totalPages: 1, pageSize: 10 });
    setEventToasts([]);
    knownAccessEventIds.current = new Set();
    accessEventsInitialized.current = false;
    setActiveTab("dashboard");
  }

  const selectedCamera = useMemo(
    () => cameras.find((camera) => camera.id === selectedCameraId) ?? cameras[0],
    [cameras, selectedCameraId]
  );

  if (!token || !user) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div>
            <p className="eyebrow">MEIP</p>
            <h1>Sistema facial</h1>
            <p className="muted">
              Entre para testar dashboard, funcionários, câmeras e painel master.
            </p>
          </div>
          <form className="form" onSubmit={handleLogin}>
            <label>
              E-mail
              <input
                name="email"
                type="email"
                placeholder="seu@email.com"
                autoComplete="email"
                required
              />
            </label>
            <label>
              Senha
              <input
                name="password"
                type="password"
                placeholder="Sua senha"
                autoComplete="current-password"
                required
              />
            </label>
            <button type="submit">Entrar</button>
          </form>
          {message ? <p className="error">{message}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">MEIP</p>
          <h1>Sistema facial</h1>
          <p className="muted">{user.name}</p>
        </div>
        <nav>
          {user.role === "tenant_admin" ? (
            <>
              <button onClick={() => setActiveTab("dashboard")}>Dashboard</button>
              <button onClick={() => setActiveTab("employees")}>Funcionários</button>
              <button onClick={() => setActiveTab("notifications")}>Notificações</button>
              <button onClick={() => setActiveTab("events")}>Eventos</button>
            </>
          ) : null}
          {user.role === "master_admin" ? (
            <button onClick={() => setActiveTab("master")}>Painel master</button>
          ) : null}
        </nav>
        <button className="ghost" onClick={logout}>
          Sair
        </button>
      </aside>

      {eventToasts.length > 0 ? (
        <div className="toast-stack" aria-live="polite">
          {eventToasts.map((toast) => (
            <div className={`event-toast ${toast.event.eventType}`} key={toast.id}>
              <div>
                <span className="toast-label">{eventLabel(toast.event.eventType)}</span>
                <strong>{toast.event.employee.fullName}</strong>
                <p>
                  {toast.event.camera.name} ·{" "}
                  {new Date(toast.event.occurredAt).toLocaleTimeString("pt-BR")}
                </p>
              </div>
              <button
                className="ghost toast-close"
                onClick={() =>
                  setEventToasts((current) => current.filter((item) => item.id !== toast.id))
                }
                aria-label="Fechar alerta"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <section className="workspace">
        {message ? <div className="notice">{message}</div> : null}

        {activeTab === "dashboard" ? (
          <DashboardView
            summary={summary}
            aiStatus={aiStatus}
            cameras={cameras}
            selectedCamera={selectedCamera}
            selectedCameraId={selectedCameraId}
            onSelectCamera={setSelectedCameraId}
          />
        ) : null}

        {activeTab === "employees" ? (
          <EmployeesView
            employees={employees}
            onCreate={async (payload, initialFace) => {
              const employee = await api<Employee>("/employees", {
                method: "POST",
                body: JSON.stringify(payload)
              });
              if (initialFace) {
                const imageDataUrl = await fileToDataUrl(initialFace);
                await api(`/employees/${employee.id}/faces`, {
                  method: "POST",
                  body: JSON.stringify({ imageDataUrl })
                });
              }
              setMessage(
                initialFace
                  ? "Funcionário e foto facial cadastrados com sucesso."
                  : "Funcionário cadastrado. Adicione ao menos uma foto facial para reconhecimento."
              );
              await loadAll();
            }}
            onUploadFace={async (employeeId, file) => {
              const imageDataUrl = await fileToDataUrl(file);
              await api(`/employees/${employeeId}/faces`, {
                method: "POST",
                body: JSON.stringify({ imageDataUrl })
              });
              setMessage("Foto facial cadastrada com sucesso.");
              await loadAll();
            }}
            onUpdate={async (employeeId, payload, newFace) => {
              await api(`/employees/${employeeId}`, {
                method: "PATCH",
                body: JSON.stringify(payload)
              });
              if (newFace) {
                const imageDataUrl = await fileToDataUrl(newFace);
                await api(`/employees/${employeeId}/faces`, {
                  method: "POST",
                  body: JSON.stringify({ imageDataUrl })
                });
              }
              setMessage("Funcionário atualizado com sucesso.");
              await loadAll();
            }}
            onDelete={async (employeeId) => {
              await api(`/employees/${employeeId}`, { method: "DELETE" });
              setMessage("Funcionário excluído. Fotos faciais removidas e histórico preservado.");
              await loadAll();
            }}
          />
        ) : null}

        {activeTab === "notifications" ? (
          <NotificationsView
            settings={notificationSettings}
            contacts={notificationContacts}
            cameras={cameras}
            onUpdateSettings={async (notificationMode) => {
              await api("/notification-settings", {
                method: "PATCH",
                body: JSON.stringify({ notificationMode })
              });
              setMessage("Configuração de alertas atualizada.");
              await loadAll();
            }}
            onCreateContact={async (payload) => {
              await api("/notification-contacts", {
                method: "POST",
                body: JSON.stringify(payload)
              });
              setMessage("Responsável cadastrado. Conecte o Telegram dele.");
              await loadAll();
            }}
            onUpdateContact={async (contactId, payload) => {
              await api(`/notification-contacts/${contactId}`, {
                method: "PATCH",
                body: JSON.stringify(payload)
              });
              setMessage("Responsável atualizado.");
              await loadAll();
            }}
            onGetTelegramLink={async (contactId) =>
              api<TelegramConnectLink>(
                `/notification-contacts/${contactId}/telegram/connect-link`
              )
            }
            onVerifyTelegram={async (contactId) => {
              const result = await api<{ connected: boolean; message: string }>(
                `/notification-contacts/${contactId}/telegram/verify`,
                { method: "POST" }
              );
              setMessage(result.message);
              await loadAll();
            }}
            onTestTelegram={async (contactId) => {
              const result = await api<{ sent: boolean; message: string }>(
                `/notification-contacts/${contactId}/telegram/test`,
                { method: "POST" }
              );
              setMessage(result.message);
            }}
          />
        ) : null}

        {activeTab === "events" ? (
          <EventsView
            events={accessEvents}
            page={accessEventsPage}
            totalPages={accessEventsMeta.totalPages}
            totalItems={accessEventsMeta.totalItems}
            pageSize={accessEventsMeta.pageSize}
            onPageChange={setAccessEventsPage}
          />
        ) : null}

        {activeTab === "master" && user.role === "master_admin" ? (
          <MasterView
            summary={masterSummary}
            tenants={tenants}
            selectedTenantId={selectedTenantId}
            managedCameras={managedCameras}
            onSelectTenant={async (tenantId) => {
              setSelectedTenantId(tenantId);
              const loadedManagedCameras = await api<Camera[]>(`/cameras?tenantId=${tenantId}`);
              setManagedCameras(loadedManagedCameras);
            }}
            onCreateTenant={async (payload) => {
              const tenant = await api<Tenant>("/tenants", {
                method: "POST",
                body: JSON.stringify(payload)
              });
              setSelectedTenantId(tenant.id);
              setManagedCameras([]);
              setMessage(
                `Cliente cadastrado. Acesso criado para ${tenant.adminEmail ?? "o responsável informado"}.`
              );
              await loadAll();
              return tenant;
            }}
            onUpdateTenant={async (tenantId, payload) => {
              const tenant = await api<Tenant>(`/tenants/${tenantId}`, {
                method: "PATCH",
                body: JSON.stringify(payload)
              });
              setMessage(
                tenant.status === "active"
                  ? "Cliente atualizado e ativo para login."
                  : "Cliente atualizado e bloqueado para login."
              );
              await loadAll();
              return tenant;
            }}
            onCreateCamera={async (payload) => {
              if (!selectedTenantId) {
                throw new Error("Selecione um cliente antes de cadastrar a câmera.");
              }

              await api(`/cameras?tenantId=${selectedTenantId}`, {
                method: "POST",
                body: JSON.stringify(payload)
              });
              setMessage("Câmera cadastrada com sucesso.");
              await loadAll();
            }}
            onUpdateCamera={async (cameraId, payload) => {
              if (!selectedTenantId) {
                throw new Error("Selecione um cliente antes de editar a câmera.");
              }

              await api(`/cameras/${cameraId}?tenantId=${selectedTenantId}`, {
                method: "PATCH",
                body: JSON.stringify(payload)
              });
              setMessage(
                payload.status === "inactive"
                  ? "Câmera atualizada e inativada. Ela não será transmitida."
                  : "Câmera atualizada e liberada para transmissão."
              );
              await loadAll();
            }}
            onTestCamera={async (cameraId) => {
              if (!selectedTenantId) {
                throw new Error("Selecione um cliente antes de testar a câmera.");
              }

              const result = await api<CameraTestResult>(
                `/cameras/${cameraId}/test?tenantId=${selectedTenantId}`,
                {
                  method: "POST"
                }
              );
              setMessage(result.message);
              await loadAll();
              return result;
            }}
          />
        ) : null}
      </section>
    </main>
  );
}

function DashboardView({
  summary,
  aiStatus,
  cameras,
  selectedCamera,
  selectedCameraId,
  onSelectCamera
}: {
  summary: Summary | null;
  aiStatus: AiStatus | null;
  cameras: Camera[];
  selectedCamera?: Camera;
  selectedCameraId: string | null;
  onSelectCamera: (id: string) => void;
}) {
  const selectedCameraStatus =
    aiStatus?.cameras.find((camera) => camera.id === selectedCamera?.id) ?? null;

  return (
    <>
      <Header title="Dashboard do cliente" subtitle="Entradas, saídas, presença e monitoramento." />
      <section className="grid stats">
        <Stat label="Entradas hoje" value={summary?.entriesToday ?? 0} />
        <Stat label="Saídas hoje" value={summary?.exitsToday ?? 0} />
        <Stat label="Presentes" value={summary?.presentEmployees ?? 0} />
        <Stat label="Ausentes" value={summary?.absentEmployees ?? 0} />
        <Stat label="Câmeras online" value={summary?.camerasOnline ?? 0} />
      </section>

      <section className="grid dashboard-grid">
        <article className="card">
          <div className="split">
            <div>
              <h2>Monitoramento ao vivo</h2>
              <p className="muted">{selectedCamera?.location ?? "Sem câmera selecionada"}</p>
            </div>
            <select
              value={selectedCameraId ?? ""}
              onChange={(event) => onSelectCamera(event.target.value)}
            >
              {cameras.map((camera) => (
                <option key={camera.id} value={camera.id}>
                  {camera.name}
                </option>
              ))}
            </select>
          </div>
          {selectedCamera ? (
            <LiveCameraPreview camera={selectedCamera} connected={selectedCameraStatus?.connected} />
          ) : (
            <div className="empty">Cadastre uma câmera para iniciar o preview.</div>
          )}
          <div className="camera-status">
            <span className={`badge ${selectedCameraStatus?.connected ? "" : "offline"}`}>
              {selectedCameraStatus?.connected ? "online" : "offline"}
            </span>
            <span className="muted">Rostos no frame: {selectedCameraStatus?.faceCount ?? 0}</span>
          </div>
          {selectedCameraStatus?.lastError ? (
            <p className="stream-error">{selectedCameraStatus.lastError}</p>
          ) : null}
        </article>

        <article className="card">
          <h2>Últimas detecções</h2>
          <div className="list">
            {(summary?.latestDetections ?? []).length === 0 ? (
              <p className="muted">Nenhuma detecção ainda.</p>
            ) : (
              summary?.latestDetections.map((item) => (
                <div className="list-row" key={item.id}>
                  <div className="event-main">
                    <DetectionPreview
                      url={item.snapshotUrl}
                      label={`Prévia da detecção de ${
                        item.employee?.fullName ?? "pessoa desconhecida"
                      }`}
                    />
                    <div>
                      <strong>{item.employee?.fullName ?? "Pessoa desconhecida"}</strong>
                      <p className="muted">
                        {eventLabel(item.eventType)} · {item.camera.name}
                      </p>
                    </div>
                  </div>
                  <span>{new Date(item.detectedAt).toLocaleTimeString("pt-BR")}</span>
                </div>
              ))
            )}
          </div>
        </article>
      </section>

      <section className="grid recognition-grid">
        <Stat label="Reconhecimentos hoje" value={summary?.recognitionsToday ?? 0} />
        <Stat label="Reconhecimentos em 30 dias" value={summary?.recognitionsThirtyDays ?? 0} />
        <Stat label="Reconhecimentos em 12 meses" value={summary?.recognitionsYear ?? 0} />
      </section>

      <section className="card attendance-card">
        <div className="split section-heading">
          <div>
            <h2>Entrada e saída por funcionário</h2>
            <p className="muted">Quantidade registrada hoje considerando a tolerância configurada.</p>
          </div>
        </div>
        <div className="attendance-table">
          <div className="attendance-header">
            <span>Funcionário</span>
            <span>Entrou no horário</span>
            <span>Entradas atrasadas</span>
            <span>Saídas</span>
          </div>
          {(summary?.employeeAttendance ?? []).length === 0 ? (
            <p className="muted">Nenhum funcionário ativo para exibir.</p>
          ) : (
            summary?.employeeAttendance.map((employee) => (
              <div className="attendance-row" key={employee.id}>
                <strong>{employee.fullName}</strong>
                <span>{employee.onTimeEntries}</span>
                <span>{employee.lateEntries}</span>
                <span>{employee.exits}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}

function LiveCameraPreview({
  camera,
  connected
}: {
  camera: Camera;
  connected?: boolean;
}) {
  const [refreshKey, setRefreshKey] = useState(Date.now());
  const [imageFailed, setImageFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const refreshTimer = useRef<number | undefined>(undefined);

  function queueNextFrame(delayMs: number) {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      setImageFailed(false);
      setRefreshKey(Date.now());
    }, delayMs);
  }

  useEffect(() => {
    window.clearTimeout(refreshTimer.current);
    setImageFailed(false);
    setRefreshKey(Date.now());
    return () => window.clearTimeout(refreshTimer.current);
  }, [camera.id, connected]);

  if (!connected) {
    return <div className="empty stream-empty">Aguardando câmera ficar online.</div>;
  }

  if (imageFailed) {
    return <div className="empty stream-empty">Câmera online, aguardando primeiro frame.</div>;
  }

  const frameUrl = `${aiUrl}/frame/${camera.id}.jpg?t=${refreshKey}`;

  return (
    <>
      <div className="stream-shell">
        <img
          className="stream"
          src={frameUrl}
          alt={`Visualização ${camera.name}`}
          onLoad={() => {
            setImageFailed(false);
            queueNextFrame(125);
          }}
          onError={() => {
            setImageFailed(true);
            queueNextFrame(1000);
          }}
        />
        <button className="expand-camera" type="button" onClick={() => setExpanded(true)}>
          Ampliar câmera
        </button>
      </div>

      {expanded ? (
        <div className="camera-modal" role="dialog" aria-modal="true">
          <div className="camera-modal-header">
            <div>
              <strong>{camera.name}</strong>
              <p className="muted">{camera.location}</p>
            </div>
            <button className="ghost" type="button" onClick={() => setExpanded(false)}>
              Fechar
            </button>
          </div>
          <img
            className="stream stream-expanded"
            src={frameUrl}
            alt={`Visualização ampliada ${camera.name}`}
          />
        </div>
      ) : null}
    </>
  );
}

function EmployeesView({
  employees,
  onCreate,
  onUploadFace,
  onUpdate,
  onDelete
}: {
  employees: Employee[];
  onCreate: (payload: Record<string, unknown>, initialFace?: File) => Promise<void>;
  onUploadFace: (employeeId: string, file: File) => Promise<void>;
  onUpdate: (
    employeeId: string,
    payload: Record<string, unknown>,
    newFace?: File
  ) => Promise<void>;
  onDelete: (employeeId: string) => Promise<void>;
}) {
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const initialFace = form.get("initialFace");
    const workDays = form.getAll("workDays").map(String);
    form.delete("initialFace");
    form.delete("workDays");

    try {
      const payload = {
        ...Object.fromEntries(form.entries()),
        workDays,
        toleranceMinutes: Number(form.get("toleranceMinutes"))
      };
      const faceFile =
        initialFace instanceof File && initialFace.size > 0 ? initialFace : undefined;
      if (editingEmployee) {
        await onUpdate(editingEmployee.id, payload, faceFile);
        setEditingEmployee(null);
      } else {
        await onCreate(payload, faceFile);
      }
      formElement.reset();
      setLocalMessage(null);
    } catch (error) {
      setLocalMessage(error instanceof Error ? error.message : "Falha ao cadastrar funcionário.");
    }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>, employeeId: string) {
    const file = event.target.files?.[0];
    if (file) {
      try {
        await onUploadFace(employeeId, file);
        setLocalMessage(null);
      } catch (error) {
        setLocalMessage(error instanceof Error ? error.message : "Falha ao adicionar foto.");
      } finally {
        event.target.value = "";
      }
    }
  }

  async function remove(employee: Employee) {
    if (!window.confirm(`Excluir ${employee.fullName}? As fotos faciais serão removidas.`)) {
      return;
    }
    try {
      await onDelete(employee.id);
      if (editingEmployee?.id === employee.id) {
        setEditingEmployee(null);
      }
      setLocalMessage(null);
    } catch (error) {
      setLocalMessage(error instanceof Error ? error.message : "Falha ao excluir funcionário.");
    }
  }

  return (
    <>
      <Header title="Funcionários" subtitle="Cadastro completo e fotos faciais múltiplas." />
      <section className="grid two-columns">
        <article className="card">
          <h2>{editingEmployee ? "Editar funcionário" : "Novo funcionário"}</h2>
          <p className="muted">
            A foto facial inicial é usada para gerar o embedding que será comparado com o rosto
            visto pela câmera.
          </p>
          <form
            key={editingEmployee?.id ?? "new-employee"}
            className="form compact"
            onSubmit={submit}
          >
            <input name="fullName" placeholder="Nome completo" defaultValue={editingEmployee?.fullName} required />
            <input name="cpf" placeholder="CPF" defaultValue={editingEmployee?.cpf ?? ""} />
            <input name="registration" placeholder="Matrícula" defaultValue={editingEmployee?.registration ?? ""} />
            <input name="phone" placeholder="Telefone" defaultValue={editingEmployee?.phone ?? ""} />
            <input name="department" placeholder="Setor" defaultValue={editingEmployee?.department ?? ""} />
            <input name="role" placeholder="Cargo" defaultValue={editingEmployee?.role ?? ""} />
            <label>
              Horário de entrada
              <input name="entryTime" type="time" defaultValue={editingEmployee?.entryTime ?? ""} required />
            </label>
            <label>
              Horário de saída
              <input name="exitTime" type="time" defaultValue={editingEmployee?.exitTime ?? ""} required />
            </label>
            <label>
              Tolerância (minutos)
              <input
                name="toleranceMinutes"
                type="number"
                min={0}
                defaultValue={editingEmployee?.toleranceMinutes ?? 10}
                required
              />
            </label>
            <fieldset className="days-field">
              <legend>Dias de trabalho</legend>
              {[
                ["mon", "Seg"],
                ["tue", "Ter"],
                ["wed", "Qua"],
                ["thu", "Qui"],
                ["fri", "Sex"],
                ["sat", "Sáb"],
                ["sun", "Dom"]
              ].map(([value, label], index) => (
                <label key={value}>
                  <input
                    name="workDays"
                    type="checkbox"
                    value={value}
                    defaultChecked={
                      editingEmployee ? editingEmployee.workDays.includes(value) : index < 5
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <label className="file-field">
              {editingEmployee ? "Adicionar nova foto facial" : "Foto facial inicial"}
              <input name="initialFace" type="file" accept="image/*" />
            </label>
            <button type="submit">
              {editingEmployee ? "Salvar alterações" : "Cadastrar funcionário"}
            </button>
            {editingEmployee ? (
              <button className="ghost" type="button" onClick={() => setEditingEmployee(null)}>
                Cancelar edição
              </button>
            ) : null}
          </form>
          {localMessage ? (
            <p
              className={
                localMessage.includes("Falha") ||
                localMessage.includes("Não foi") ||
                localMessage.includes("Ainda não")
                  ? "error inline-error"
                  : "notice inline-error"
              }
            >
              {localMessage}
            </p>
          ) : null}
        </article>
        <article className="card">
          <h2>Equipe cadastrada</h2>
          <p className="muted recognition-note">
            Reconhecimento executado localmente. Após a atualização do motor facial, fotos
            antigas devem ser reenviadas para ativar o novo reconhecimento.
          </p>
          <div className="list">
            {employees.map((employee) => (
              <div className="employee-row" key={employee.id}>
                <div>
                  <strong>{employee.fullName}</strong>
                  <p className="muted">
                    {employee.department || "Sem setor"} · {employee.role || "Sem cargo"} ·{" "}
                    {employee.recognitionFaceCount} foto(s) apta(s) ao reconhecimento
                  </p>
                  {employee.faceCount > employee.recognitionFaceCount ? (
                    <p className="migration-warning">
                      {employee.faceCount - employee.recognitionFaceCount} foto(s) antiga(s):
                      adicione novas fotos para reconhecimento.
                    </p>
                  ) : null}
                  <p className="muted">
                    Jornada: {employee.entryTime || "--:--"}–{employee.exitTime || "--:--"} ·
                    tolerância {employee.toleranceMinutes ?? 10} min
                  </p>
                </div>
                <div className="row-actions">
                  <button className="ghost" onClick={() => setEditingEmployee(employee)}>
                    Editar
                  </button>
                  <label className="upload">
                    Adicionar foto
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => upload(event, employee.id)}
                    />
                  </label>
                  <button className="danger" onClick={() => remove(employee)}>
                    Excluir
                  </button>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>
    </>
  );
}

function NotificationsView({
  settings,
  contacts,
  cameras,
  onUpdateSettings,
  onCreateContact,
  onUpdateContact,
  onGetTelegramLink,
  onVerifyTelegram,
  onTestTelegram
}: {
  settings: NotificationSettings | null;
  contacts: NotificationContact[];
  cameras: Camera[];
  onUpdateSettings: (mode: NotificationSettings["notificationMode"]) => Promise<void>;
  onCreateContact: (payload: Record<string, unknown>) => Promise<void>;
  onUpdateContact: (contactId: string, payload: Record<string, unknown>) => Promise<void>;
  onGetTelegramLink: (contactId: string) => Promise<TelegramConnectLink>;
  onVerifyTelegram: (contactId: string) => Promise<void>;
  onTestTelegram: (contactId: string) => Promise<void>;
}) {
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [telegramLinks, setTelegramLinks] = useState<Record<string, TelegramConnectLink>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editingContact, setEditingContact] = useState<NotificationContact | null>(null);

  async function submitContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = {
      name: String(form.get("name") ?? ""),
      status: String(form.get("status") ?? "active"),
      notifyTelegram: form.get("notifyTelegram") === "on",
      notifyEmail: form.get("notifyEmail") === "on",
      email: String(form.get("email") ?? "").trim() || null,
      cameraIds: form.getAll("cameraIds").map(String)
    };

    try {
      if (editingContact) {
        await onUpdateContact(editingContact.id, payload);
        setEditingContact(null);
      } else {
        await onCreateContact(payload);
      }
      formElement.reset();
      setLocalMessage(null);
    } catch (error) {
      setLocalMessage(error instanceof Error ? error.message : "Falha ao salvar responsável.");
    }
  }

  async function connectTelegram(contactId: string) {
    const popup = window.open("about:blank", "_blank");

    try {
      setPendingId(contactId);
      const link = await onGetTelegramLink(contactId);
      setTelegramLinks((current) => ({ ...current, [contactId]: link }));

      if (popup) {
        popup.location.href = link.link;
      }

      setLocalMessage(
        `Bot @${link.botUsername} aberto. Toque em Iniciar; a conexão será reconhecida automaticamente em alguns segundos.`
      );
    } catch (error) {
      popup?.close();
      setLocalMessage(error instanceof Error ? error.message : "Falha ao conectar Telegram.");
    } finally {
      setPendingId(null);
    }
  }

  async function verifyTelegram(contactId: string) {
    try {
      setPendingId(contactId);
      await onVerifyTelegram(contactId);
      setLocalMessage("Responsável conectado ao Telegram com sucesso.");
    } catch (error) {
      setLocalMessage(error instanceof Error ? error.message : "Falha ao verificar Telegram.");
    } finally {
      setPendingId(null);
    }
  }

  async function testTelegram(contactId: string) {
    try {
      setPendingId(contactId);
      await onTestTelegram(contactId);
      setLocalMessage("Mensagem de teste enviada para o Telegram.");
    } catch (error) {
      setLocalMessage(error instanceof Error ? error.message : "Falha ao enviar teste.");
    } finally {
      setPendingId(null);
    }
  }

  async function toggleStatus(contact: NotificationContact) {
    try {
      setPendingId(contact.id);
      await onUpdateContact(contact.id, {
        status: contact.status === "active" ? "inactive" : "active"
      });
      setLocalMessage(
        contact.status === "active"
          ? "Responsável inativado."
          : "Responsável ativado."
      );
    } catch (error) {
      setLocalMessage(error instanceof Error ? error.message : "Falha ao alterar responsável.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <Header
        title="Notificações"
        subtitle="Configure quem será avisado quando a câmera reconhecer colaboradores."
      />
      <section className="grid two-columns">
        <article className="card">
          <h2>Regra dos alertas</h2>
          <p className="muted">
            Pessoas desconhecidas sempre geram alerta. Para colaboradores, escolha o nível de
            aviso.
          </p>
          <select
            value={settings?.notificationMode ?? "all_events"}
            onChange={(event) =>
              onUpdateSettings(event.target.value as NotificationSettings["notificationMode"])
            }
          >
            <option value="all_events">Avisar em toda entrada e saída</option>
            <option value="exceptions_only">Avisar somente atrasos e saídas antecipadas</option>
          </select>
          <h2 className="section-subtitle">
            {editingContact ? "Editar responsável" : "Novo responsável"}
          </h2>
          <form className="form" onSubmit={submitContact} key={editingContact?.id ?? "new"}>
            <input
              name="name"
              placeholder="Ex.: Diretor, coordenador ou portaria"
              defaultValue={editingContact?.name ?? ""}
              required
            />
            <select name="status" defaultValue={editingContact?.status ?? "active"}>
              <option value="active">Ativo</option>
              <option value="inactive">Inativo</option>
            </select>
            <div className="form-group">
              <span className="form-group-title">Canais de notificação</span>
              <p className="muted form-helper">
                Escolha por onde este responsável será avisado quando houver reconhecimento.
              </p>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                name="notifyTelegram"
                defaultChecked={editingContact?.notifyTelegram ?? true}
              />
              <span>
                <strong>Telegram</strong>
                <small>Enviar alerta para o Telegram conectado deste responsável.</small>
              </span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                name="notifyEmail"
                defaultChecked={editingContact?.notifyEmail ?? false}
              />
              <span>
                <strong>E-mail</strong>
                <small>Enviar também para o endereço informado abaixo.</small>
              </span>
            </label>
            <input
              name="email"
              type="email"
              placeholder="E-mail do responsável"
              defaultValue={editingContact?.email ?? ""}
            />
            <div className="camera-checks">
              <div className="form-group">
                <span className="form-group-title">Câmeras liberadas para notificação</span>
                <p className="muted form-helper">
                  Marque apenas as câmeras que este responsável deve acompanhar.
                </p>
              </div>
              <p className="muted form-note">
                Se nenhuma câmera for marcada, ele recebe alertas de todas as câmeras.
              </p>
              {cameras.length === 0 ? (
                <p className="muted">Nenhuma câmera cadastrada para este cliente.</p>
              ) : (
                cameras.map((camera) => (
                  <label className="check-row" key={camera.id}>
                    <input
                      type="checkbox"
                      name="cameraIds"
                      value={camera.id}
                      defaultChecked={editingContact?.cameraIds.includes(camera.id) ?? false}
                    />
                    <span>
                      <strong>{camera.name}</strong>
                      <small>{camera.location}</small>
                    </span>
                  </label>
                ))
              )}
            </div>
            <div className="row-actions form-actions">
              <button type="submit">
                {editingContact ? "Salvar responsável" : "Cadastrar responsável"}
              </button>
              {editingContact ? (
                <button className="ghost" type="button" onClick={() => setEditingContact(null)}>
                  Cancelar edição
                </button>
              ) : null}
            </div>
          </form>
          {localMessage ? <p className="notice inline-error">{localMessage}</p> : null}
        </article>
        <article className="card">
          <h2>Destinatários</h2>
          <div className="list">
            {contacts.length === 0 ? (
              <p className="muted">Nenhum responsável configurado para receber alertas.</p>
            ) : (
              contacts.map((contact) => (
                <div className="employee-row" key={contact.id}>
                  <div>
                    <strong>{contact.name}</strong>
                    <p className="muted">
                      {contact.status === "active" ? "Ativo" : "Inativo"} ·{" "}
                      {contact.notifyTelegram
                        ? contact.connected
                          ? "Telegram conectado"
                          : "Telegram pendente"
                        : "Telegram desligado"}{" "}
                      · {contact.notifyEmail ? contact.email ?? "E-mail pendente" : "E-mail desligado"}
                    </p>
                    <p className="muted">
                      {contact.cameraIds.length === 0
                        ? "Recebe todas as câmeras"
                        : `Recebe ${contact.cameraIds.length} câmera(s) selecionada(s)`}
                    </p>
                  </div>
                  <div className="row-actions">
                    <button className="ghost" onClick={() => setEditingContact(contact)}>
                      Editar
                    </button>
                    <button
                      className={contact.status === "active" ? "danger" : "ghost"}
                      disabled={pendingId === contact.id}
                      onClick={() => toggleStatus(contact)}
                    >
                      {contact.status === "active" ? "Inativar" : "Ativar"}
                    </button>
                    {contact.notifyTelegram && contact.connected ? (
                      <>
                        <span className="badge">Telegram ativo</span>
                        <button
                          className="ghost"
                          disabled={pendingId === contact.id}
                          onClick={() => testTelegram(contact.id)}
                        >
                          {pendingId === contact.id ? "Enviando..." : "Enviar teste"}
                        </button>
                      </>
                    ) : contact.notifyTelegram ? (
                      <>
                        <button
                          className="ghost"
                          disabled={pendingId === contact.id}
                          onClick={() => connectTelegram(contact.id)}
                        >
                          {pendingId === contact.id ? "Abrindo..." : "Conectar Telegram"}
                        </button>
                        {telegramLinks[contact.id] ? (
                          <a
                            className="button-link ghost"
                            href={telegramLinks[contact.id].link}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Abrir bot
                          </a>
                        ) : null}
                        <button
                          className="ghost"
                          disabled={pendingId === contact.id}
                          onClick={() => verifyTelegram(contact.id)}
                        >
                          Atualizar conexão
                        </button>
                      </>
                    ) : contact.notifyEmail ? (
                      <button
                        className="ghost"
                        disabled={pendingId === contact.id}
                        onClick={() => testTelegram(contact.id)}
                      >
                        {pendingId === contact.id ? "Enviando..." : "Enviar teste"}
                      </button>
                    ) : (
                      <span className="badge inactive">Sem canal</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </article>
      </section>
    </>
  );
}

function CamerasView({
  cameras,
  onCreate,
  onUpdate,
  onTest
}: {
  cameras: Camera[];
  onCreate: (payload: Record<string, unknown>) => Promise<void>;
  onUpdate: (cameraId: string, payload: Record<string, unknown>) => Promise<void>;
  onTest: (cameraId: string) => Promise<CameraTestResult>;
}) {
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [localMessageSuccess, setLocalMessageSuccess] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, CameraTestResult>>({});
  const [testingCameraId, setTestingCameraId] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState<Camera["sourceType"]>("rtsp");
  const [editingCamera, setEditingCamera] = useState<Camera | null>(null);

  function startEdit(camera: Camera) {
    setEditingCamera(camera);
    setSourceType(camera.sourceType);
    setLocalMessage(null);
  }

  function cancelEdit() {
    setEditingCamera(null);
    setSourceType("rtsp");
    setLocalMessage(null);
  }

  function buildPayload(form: FormData) {
    const payload: Record<string, unknown> = {
      ...Object.fromEntries(form.entries()),
      sourceType,
      status: form.get("status") ?? "configured"
    };

    if (sourceType === "webcam") {
      payload.deviceIndex = Number(form.get("deviceIndex") ?? 0);
      delete payload.rtspUrl;
      delete payload.rtmpStreamKey;
    } else if (sourceType === "rtmp") {
      delete payload.deviceIndex;
      delete payload.rtspUrl;
    } else {
      delete payload.deviceIndex;
      delete payload.rtmpStreamKey;
    }

    return payload;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const payload = buildPayload(form);
      if (editingCamera) {
        await onUpdate(editingCamera.id, payload);
        setLocalMessage("Camera atualizada com sucesso.");
      } else {
        await onCreate(payload);
        setLocalMessage("Camera cadastrada com sucesso.");
      }
      formElement.reset();
      setEditingCamera(null);
      setSourceType("rtsp");
      setLocalMessageSuccess(true);
    } catch (error) {
      setLocalMessageSuccess(false);
      setLocalMessage(error instanceof Error ? error.message : "Falha ao salvar camera.");
    }
  }

  async function quickStatus(camera: Camera, status: "configured" | "inactive") {
    try {
      await onUpdate(camera.id, { status });
      setLocalMessageSuccess(true);
      setLocalMessage(
        status === "inactive"
          ? "Camera inativada. O cliente nao vera nem transmitira essa camera."
          : "Camera ativada e liberada para o cliente."
      );
    } catch (error) {
      setLocalMessageSuccess(false);
      setLocalMessage(error instanceof Error ? error.message : "Falha ao alterar status.");
    }
  }

  async function test(camera: Camera) {
    if (camera.status === "inactive") {
      setLocalMessageSuccess(false);
      setLocalMessage("Camera inativa. Ative antes de testar.");
      return;
    }

    try {
      setTestingCameraId(camera.id);
      const result = await onTest(camera.id);
      setTestResults((current) => ({ ...current, [camera.id]: result }));
      setLocalMessageSuccess(result.connected);
      setLocalMessage(result.message);
    } catch (error) {
      setLocalMessageSuccess(false);
      setLocalMessage(error instanceof Error ? error.message : "Falha ao testar camera.");
    } finally {
      setTestingCameraId(null);
    }
  }

  return (
    <>
      <Header title="Cameras" subtitle="Cameras liberadas para o cliente selecionado." />
      <section className="grid two-columns">
        <article className="card">
          <h2>{editingCamera ? "Editar camera" : "Nova camera"}</h2>
          <p className="muted">
            Use RTSP para puxar da camera, RTMP para a camera enviar o stream ao sistema, ou
            Webcam local para testes no computador da IA.
          </p>
          <form className="form compact" onSubmit={submit} key={editingCamera?.id ?? "new-camera"}>
            <input name="name" placeholder="Nome" defaultValue={editingCamera?.name ?? ""} required />
            <select
              name="sourceType"
              value={sourceType}
              onChange={(event) => setSourceType(event.target.value as Camera["sourceType"])}
            >
              <option value="rtsp">Camera RTSP</option>
              <option value="rtmp">Camera RTMP</option>
              <option value="webcam">Webcam local</option>
            </select>
            {sourceType === "rtsp" ? (
              <input name="rtspUrl" placeholder="RTSP" defaultValue={editingCamera?.rtspUrl ?? ""} required />
            ) : null}
            {sourceType === "rtmp" ? (
              <>
                <label>
                  Chave RTMP / Stream (editável)
                  <input
                    name="rtmpStreamKey"
                    placeholder="ex.: escola-portaria"
                    defaultValue={editingCamera ? rtmpStreamKey(editingCamera) ?? "" : ""}
                  />
                </label>
                <p className="muted form-note">
                  O padrão de publicação é sempre rtmp://IP:1935/live/CHAVE. Ao editar esta chave,
                  atualize também o destino configurado na câmera. Se deixar em branco no cadastro,
                  o sistema gera uma chave automaticamente.
                </p>
              </>
            ) : null}
            {sourceType === "webcam" ? (
              <label>
                Numero da webcam
                <input
                  name="deviceIndex"
                  type="number"
                  min="0"
                  max="20"
                  defaultValue={editingCamera?.deviceIndex ?? 0}
                  required
                />
              </label>
            ) : null}
            <input name="location" placeholder="Localizacao" defaultValue={editingCamera?.location ?? ""} required />
            <input name="sector" placeholder="Setor" defaultValue={editingCamera?.sector ?? ""} />
            <select name="mode" defaultValue={editingCamera?.mode ?? "general"}>
              <option value="entry">Entrada</option>
              <option value="exit">Saida</option>
              <option value="general">Entrada/Saida automatica</option>
            </select>
            <select
              name="status"
              defaultValue={editingCamera?.status === "inactive" ? "inactive" : "configured"}
            >
              <option value="configured">Ativa / liberada</option>
              <option value="inactive">Inativa / bloqueada</option>
            </select>
            <div className="row-actions form-actions">
              {editingCamera ? (
                <button type="button" className="ghost" onClick={cancelEdit}>
                  Cancelar edicao
                </button>
              ) : null}
              <button type="submit">{editingCamera ? "Salvar camera" : "Cadastrar camera"}</button>
            </div>
          </form>
          {localMessage ? (
            <p className={localMessageSuccess ? "notice inline-error" : "error inline-error"}>
              {localMessage}
            </p>
          ) : null}
        </article>
        <article className="card">
          <h2>Cameras cadastradas</h2>
          <p className="muted form-note">
            Estas sao as cameras liberadas para este cliente. Cameras inativas nao aparecem para o
            cliente e nao entram no monitoramento.
          </p>
          <div className="list">
            {cameras.length === 0 ? (
              <p className="muted">Nenhuma camera liberada para este cliente.</p>
            ) : (
              cameras.map((camera) => (
                <div className="list-row" key={camera.id}>
                  <div>
                    {(() => {
                      const publishInfo = rtmpPublishInfo(camera);
                      return publishInfo ? (
                        <div className="rtmp-box">
                          <span className="muted">Configuração RTMP para a camera do cliente</span>
                          <small>Servidor RTMP</small>
                          <code>{publishInfo.serverUrl}</code>
                          <small>Chave / Stream</small>
                          <code>{publishInfo.streamKey}</code>
                          <small>URL completa</small>
                          <code>{publishInfo.publishUrl}</code>
                        </div>
                      ) : null;
                    })()}
                    <div className="status-line">
                      <strong>{camera.name}</strong>
                      <span className={`badge ${camera.status === "inactive" ? "inactive" : ""}`}>
                        {camera.status === "inactive" ? "inativa" : "ativa"}
                      </span>
                    </div>
                    <p className="muted">
                      {camera.location} - {eventLabel(camera.mode)} - {camera.status}
                    </p>
                    <p className="muted">
                      {camera.sourceType === "webcam"
                        ? `Webcam local #${camera.deviceIndex ?? 0}`
                        : camera.sourceType === "rtmp"
                          ? "Camera RTMP"
                          : "Camera RTSP"}
                    </p>
                    {testResults[camera.id] ? (
                      <p className="muted">
                        Ultimo teste: {testResults[camera.id].connected ? "online" : "offline"} - {" "}
                        {testResults[camera.id].message}
                      </p>
                    ) : null}
                  </div>
                  <div className="row-actions">
                    <button className="ghost" onClick={() => startEdit(camera)}>
                      Editar
                    </button>
                    <button
                      className={camera.status === "inactive" ? "ghost" : "danger"}
                      onClick={() => quickStatus(camera, camera.status === "inactive" ? "configured" : "inactive")}
                    >
                      {camera.status === "inactive" ? "Ativar" : "Inativar"}
                    </button>
                    <button
                      className="ghost"
                      disabled={testingCameraId === camera.id || camera.status === "inactive"}
                      onClick={() => test(camera)}
                    >
                      {testingCameraId === camera.id ? "Testando..." : "Testar"}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </article>
      </section>
    </>
  );
}

function EventsView({
  events,
  page,
  totalPages,
  totalItems,
  pageSize,
  onPageChange
}: {
  events: AccessEvent[];
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const firstItem = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastItem = Math.min(page * pageSize, totalItems);

  return (
    <>
      <Header title="Eventos de acesso" subtitle="Entrada, saída e permanência por funcionário." />
      <article className="card">
        <div className="events-toolbar">
          <div>
            <h2>Histórico paginado</h2>
            <p className="muted">
              {totalItems === 0
                ? "Nenhum evento encontrado."
                : `Mostrando ${firstItem}-${lastItem} de ${totalItems} evento(s).`}
            </p>
          </div>
          <div className="pagination">
            <button
              className="ghost"
              disabled={page <= 1}
              onClick={() => onPageChange(Math.max(1, page - 1))}
            >
              Anterior
            </button>
            <span>
              Página {page} de {totalPages}
            </span>
            <button
              className="ghost"
              disabled={page >= totalPages}
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            >
              Próxima
            </button>
          </div>
        </div>
        <div className="list">
          {events.length === 0 ? (
            <p className="muted">Nenhum evento de acesso ainda.</p>
          ) : (
            events.map((event) => (
              <div className="list-row event-row" key={event.id}>
                <div className="event-main">
                  <DetectionPreview
                    url={event.snapshotUrl}
                    label={`Prévia do evento de ${event.employee.fullName}`}
                  />
                  <div>
                    <strong>{event.employee.fullName}</strong>
                    <p className="muted">
                      {eventLabel(event.eventType)} · {event.camera.name} ·{" "}
                      {event.camera.location}
                    </p>
                  </div>
                </div>
                <span className="event-date">
                  {new Date(event.occurredAt).toLocaleString("pt-BR")}
                </span>
              </div>
            ))
          )}
        </div>
      </article>
    </>
  );
}

function MasterView({
  summary,
  tenants,
  selectedTenantId,
  managedCameras,
  onSelectTenant,
  onCreateTenant,
  onUpdateTenant,
  onCreateCamera,
  onUpdateCamera,
  onTestCamera
}: {
  summary: MasterSummary | null;
  tenants: Tenant[];
  selectedTenantId: string | null;
  managedCameras: Camera[];
  onSelectTenant: (tenantId: string) => Promise<void>;
  onCreateTenant: (payload: Record<string, unknown>) => Promise<Tenant>;
  onUpdateTenant: (tenantId: string, payload: Record<string, unknown>) => Promise<Tenant>;
  onCreateCamera: (payload: Record<string, unknown>) => Promise<void>;
  onUpdateCamera: (cameraId: string, payload: Record<string, unknown>) => Promise<void>;
  onTestCamera: (cameraId: string) => Promise<CameraTestResult>;
}) {
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const selectedTenant = tenants.find((tenant) => tenant.id === selectedTenantId) ?? null;

  function startTenantEdit(tenant: Tenant) {
    setEditingTenant(tenant);
    setLocalMessage(null);
  }

  function cancelTenantEdit() {
    setEditingTenant(null);
    setLocalMessage(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const adminPassword = String(form.get("adminPassword") ?? "");
    const payload: Record<string, unknown> = {
      ...Object.fromEntries(form.entries()),
      employeeLimit: Number(form.get("employeeLimit")),
      cameraLimit: Number(form.get("cameraLimit"))
    };

    if (!adminPassword) {
      delete payload.adminPassword;
    }

    try {
      if (editingTenant) {
        await onUpdateTenant(editingTenant.id, payload);
        setLocalMessage("Cliente atualizado com sucesso.");
      } else {
        const tenant = await onCreateTenant(payload);
        await onSelectTenant(tenant.id);
        setLocalMessage("Cliente cadastrado com sucesso.");
      }
      formElement.reset();
      setEditingTenant(null);
    } catch (error) {
      setLocalMessage(error instanceof Error ? error.message : "Falha ao salvar cliente.");
    }
  }

  async function quickTenantStatus(tenant: Tenant, status: "active" | "inactive") {
    try {
      await onUpdateTenant(tenant.id, { status });
      setLocalMessage(
        status === "active"
          ? "Cliente ativado. O acesso foi liberado."
          : "Cliente inativado. O acesso foi bloqueado."
      );
    } catch (error) {
      setLocalMessage(error instanceof Error ? error.message : "Falha ao alterar status do cliente.");
    }
  }

  return (
    <>
      <Header title="Painel master" subtitle="Clientes, planos, limites e visao geral." />
      <section className="grid stats">
        <Stat label="Clientes" value={summary?.tenantCount ?? 0} />
        <Stat label="Clientes ativos" value={summary?.activeClients ?? 0} />
        <Stat label="Funcionarios" value={summary?.employeeCount ?? 0} />
        <Stat label="Deteccoes" value={summary?.detectionCount ?? 0} />
        <Stat label="Cameras online" value={summary?.camerasOnline ?? 0} />
      </section>
      <section className="grid two-columns">
        <article className="card">
          <h2>{editingTenant ? "Editar cliente" : "Novo cliente"}</h2>
          <p className="muted">
            Cliente inativo nao consegue fazer login. As cameras dele tambem saem do monitoramento.
          </p>
          <form className="form compact" onSubmit={submit} key={editingTenant?.id ?? "new-tenant"}>
            <input name="name" placeholder="Nome do cliente" defaultValue={editingTenant?.name ?? ""} required />
            <select name="status" defaultValue={editingTenant?.status ?? "active"}>
              <option value="active">Cliente ativo</option>
              <option value="inactive">Cliente inativo</option>
            </select>
            <input name="plan" placeholder="Plano" defaultValue={editingTenant?.plan ?? "local"} />
            <input
              name="subscriptionStatus"
              placeholder="Status da assinatura"
              defaultValue={editingTenant?.subscriptionStatus ?? "active"}
            />
            <input name="adminName" placeholder="Nome do responsavel" defaultValue={editingTenant?.adminName ?? ""} required />
            <input
              name="adminEmail"
              type="email"
              placeholder="E-mail de acesso"
              defaultValue={editingTenant?.adminEmail ?? ""}
              required
            />
            <input
              name="adminPassword"
              type="password"
              placeholder={editingTenant ? "Nova senha, se quiser trocar" : "Senha inicial"}
              minLength={6}
              required={!editingTenant}
            />
            <input name="employeeLimit" type="number" defaultValue={editingTenant?.employeeLimit ?? 50} />
            <input name="cameraLimit" type="number" defaultValue={editingTenant?.cameraLimit ?? 10} />
            <div className="row-actions form-actions">
              {editingTenant ? (
                <button type="button" className="ghost" onClick={cancelTenantEdit}>
                  Cancelar edicao
                </button>
              ) : null}
              <button type="submit">{editingTenant ? "Salvar cliente" : "Cadastrar cliente"}</button>
            </div>
          </form>
          {localMessage ? <p className="notice inline-error">{localMessage}</p> : null}
        </article>
        <article className="card">
          <h2>Clientes</h2>
          <div className="list">
            {tenants.map((tenant) => (
              <div className="list-row" key={tenant.id}>
                <div>
                  <div className="status-line">
                    <strong>{tenant.name}</strong>
                    <span className={`badge ${tenant.status === "inactive" ? "inactive" : ""}`}>
                      {tenant.status === "inactive" ? "inativo" : "ativo"}
                    </span>
                  </div>
                  <p className="muted">
                    {tenant.plan} - {tenant.employeeLimit} funcionarios - {tenant.cameraLimit} cameras
                  </p>
                  <p className="muted">Acesso do cliente: {tenant.adminEmail ?? "nao informado"}</p>
                </div>
                <div className="row-actions">
                  <button className="ghost" onClick={() => startTenantEdit(tenant)}>
                    Editar
                  </button>
                  <button className="ghost" onClick={() => onSelectTenant(tenant.id)}>
                    Gerenciar cameras
                  </button>
                  <button
                    className={tenant.status === "inactive" ? "ghost" : "danger"}
                    onClick={() => quickTenantStatus(tenant, tenant.status === "inactive" ? "active" : "inactive")}
                  >
                    {tenant.status === "inactive" ? "Ativar" : "Inativar"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>
      <section className="master-camera-section">
        <div className="split section-heading">
          <div>
            <h2>Cameras liberadas para o cliente</h2>
            <p className="muted">
              Selecione o cliente e cadastre/edite somente as cameras que ele podera visualizar.
            </p>
          </div>
          <select
            value={selectedTenantId ?? ""}
            onChange={(event) => onSelectTenant(event.target.value)}
          >
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name} {tenant.status === "inactive" ? "(inativo)" : ""}
              </option>
            ))}
          </select>
        </div>
        {selectedTenant ? (
          <p className="muted selected-tenant-note">
            Cliente selecionado: <strong>{selectedTenant.name}</strong> - {managedCameras.length} camera(s)
            cadastrada(s). O cliente so vera as cameras ativas.
          </p>
        ) : null}
        {selectedTenantId ? (
          <CamerasView
            cameras={managedCameras}
            onCreate={onCreateCamera}
            onUpdate={onUpdateCamera}
            onTest={onTestCamera}
          />
        ) : (
          <article className="card">
            <p className="muted">Cadastre um cliente antes de adicionar cameras.</p>
          </article>
        )}
      </section>
    </>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="page-header">
      <h2>{title}</h2>
      <p className="muted">{subtitle}</p>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <article className="card stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function Chart({ title, points }: { title: string; points: ChartPoint[] }) {
  const max = Math.max(...points.map((point) => point.value), 1);

  return (
    <article className="card chart-card">
      <h3>{title}</h3>
      <div className="bars">
        {points.length === 0 ? (
          <p className="muted">Sem dados.</p>
        ) : (
          points.map((point) => (
            <div key={point.label}>
              <span style={{ height: `${Math.max((point.value / max) * 100, 8)}%` }} />
              <small>{point.label}</small>
            </div>
          ))
        )}
      </div>
    </article>
  );
}

