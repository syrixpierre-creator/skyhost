import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSession } from "./lib/session";
import { MaintenanceScreen, useDashboardClosed } from "./components/Maintenance";
import { Layout } from "./components/Layout";
import { Button, Skeleton } from "./components/ui";
import { post } from "./lib/api";
import { t } from "./lib/i18n";

const Auth = lazy(() => import("./pages/Auth"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Landing = lazy(() => import("./pages/Landing"));
const NewProject = lazy(() => import("./pages/NewProject"));
const Project = lazy(() => import("./pages/Project"));
const Service = lazy(() => import("./pages/Service"));
const Deployment = lazy(() => import("./pages/Deployment"));
const Database = lazy(() => import("./pages/Database"));
const TeamSettings = lazy(() => import("./pages/TeamSettings"));
const Account = lazy(() => import("./pages/Account"));
const Billing = lazy(() => import("./pages/Billing"));
const Referrals = lazy(() => import("./pages/Referrals"));
const Templates = lazy(() => import("./pages/Templates"));
const Admin = lazy(() => import("./pages/Admin"));
const Public = lazy(() => import("./pages/Public"));
const Support = lazy(() => import("./pages/Support"));

function Loading() {
  return (
    <div className="space-y-3 p-8">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

/** Signed-in users get their dashboard at "/", visitors the public home page. */
function Home() {
  const { me, loading } = useSession();
  if (loading) return <Loading />;
  return me ? <Protected><Dashboard /></Protected> : <Landing />;
}

function Protected({ children }: { children: ReactNode }) {
  const { me, loading } = useSession();
  const closed = useDashboardClosed();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  // Closed for maintenance: administrators keep the dashboard, everyone else sees the maintenance page.
  if (closed && !me.user.isAdmin && !me.impersonating)
    return (
      <MaintenanceScreen>
        <Button onClick={() => post("/auth/logout").finally(() => (window.location.href = "/login"))}>{t("nav.logout")}</Button>
      </MaintenanceScreen>
    );
  return <Layout>{children}</Layout>;
}

export function App() {
  // Strings translated with the module-level t() refresh when the whole tree remounts on a language change.
  const { i18n } = useTranslation();
  return (
    <Suspense key={i18n.language} fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<Auth mode="login" />} />
        <Route path="/signup" element={<Auth mode="signup" />} />
        <Route path="/forgot-password" element={<Auth mode="forgot" />} />
        <Route path="/reset-password" element={<Auth mode="reset" />} />
        <Route path="/verify-email" element={<Auth mode="verify" />} />
        <Route path="/r/:code" element={<Auth mode="referral" />} />
        <Route path="/invite" element={<Public page="invite" />} />
        <Route path="/status" element={<Public page="status" />} />
        <Route path="/status/:slug" element={<Public page="project-status" />} />
        <Route path="/s/:token" element={<Public page="shared-screenshot" />} />
        <Route path="/report-abuse" element={<Public page="abuse" />} />
        <Route path="/terms" element={<Public page="terms" />} />
        <Route path="/privacy" element={<Public page="privacy" />} />
        <Route path="/cli" element={<Protected><Public page="cli" /></Protected>} />
        <Route path="/" element={<Home />} />
        <Route path="/new" element={<Protected><NewProject /></Protected>} />
        <Route path="/databases/new" element={<Protected><NewProject key="database" /></Protected>} />
        <Route path="/templates" element={<Protected><Templates /></Protected>} />
        <Route path="/projects/:projectId" element={<Protected><Project /></Protected>} />
        <Route path="/projects/:projectId/services/:serviceId" element={<Protected><Service /></Protected>} />
        <Route path="/projects/:projectId/deployments/:deploymentId" element={<Protected><Deployment /></Protected>} />
        <Route path="/projects/:projectId/databases/:databaseId" element={<Protected><Database /></Protected>} />
        <Route path="/settings" element={<Protected><TeamSettings /></Protected>} />
        <Route path="/account" element={<Protected><Account /></Protected>} />
        <Route path="/billing" element={<Protected><Billing /></Protected>} />
        <Route path="/referrals" element={<Protected><Referrals /></Protected>} />
        <Route path="/support" element={<Protected><Support /></Protected>} />
        <Route path="/support/:ticketId" element={<Protected><Support /></Protected>} />
        <Route path="/admin/*" element={<Protected><Admin /></Protected>} />
        <Route path="*" element={<Public page="404" />} />
      </Routes>
    </Suspense>
  );
}
