import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, get } from "./api";

export interface Me {
  user: { id: string; email: string; name: string; emailVerified: boolean; twoFactorEnabled: boolean; isAdmin: boolean; referralCode: string; locale: string; avatarUrl: string | null };
  impersonating: { by: string; reason: string } | null;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  role: string;
  personal: boolean;
  plan: { slug: string; name: string } | null;
  billingStatus: string;
  creditBalanceCents: number;
  suspended: boolean;
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  teams: Team[];
  team: Team | null;
  setTeamId: (id: string) => void;
  refresh: () => void;
}

const Ctx = createContext<SessionValue>({ me: null, loading: true, teams: [], team: null, setTeamId: () => {}, refresh: () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meQ = useQuery({
    queryKey: ["me"],
    queryFn: () => get<Me>("/auth/me").catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
    retry: false,
    staleTime: 60_000,
  });
  const teamsQ = useQuery({ queryKey: ["teams"], queryFn: () => get<{ teams: Team[] }>("/teams"), enabled: !!meQ.data, staleTime: 30_000 });
  const [teamId, setTeamIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem("sh-team");
    } catch {
      return null;
    }
  });
  const teams = teamsQ.data?.teams ?? [];
  const team = teams.find((t) => t.id === teamId) ?? teams[0] ?? null;
  useEffect(() => {
    if (team && team.id !== teamId) setTeamIdState(team.id);
  }, [team, teamId]);
  const value = useMemo<SessionValue>(
    () => ({
      me: meQ.data ?? null,
      loading: meQ.isLoading || (!!meQ.data && teamsQ.isLoading),
      teams,
      team,
      setTeamId: (id) => {
        setTeamIdState(id);
        try {
          localStorage.setItem("sh-team", id);
        } catch {
          /* ignore */
        }
      },
      refresh: () => {
        void qc.invalidateQueries({ queryKey: ["me"] });
        void qc.invalidateQueries({ queryKey: ["teams"] });
      },
    }),
    [meQ.data, meQ.isLoading, teamsQ.isLoading, teams, team, qc],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);

export function useTeam(): Team {
  const { team } = useSession();
  if (!team) throw new Error("No team selected");
  return team;
}

/** Re-renders when a realtime channel publishes, and invalidates the given queries. */
export function useRealtimeInvalidate(channel: string | null, keys: unknown[][]) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!channel) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = import("./api").then(({ realtime }) =>
      realtime.subscribe(channel, () => {
        if (t) return;
        t = setTimeout(() => {
          t = null;
          for (const k of keys) void qc.invalidateQueries({ queryKey: k });
        }, 300);
      }),
    );
    return () => {
      void unsub.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, qc, JSON.stringify(keys)]);
}
