import { useQuery } from "@tanstack/react-query";
import { get } from "./api";

export interface Capabilities {
  auth: { password: boolean; github: boolean; google: boolean; gitlab: boolean };
  git: { github: boolean; gitlab: boolean; bitbucket: boolean };
  payments: { enabled: boolean; stripe: boolean; paypal: boolean; mobileMoney: boolean };
  email: { delivery: boolean; verificationRequired: boolean };
  support: { email: string | null };
  maintenance: { enabled: boolean; message?: string; blockDeploys?: boolean; closeDashboard?: boolean; endsAt?: string | null };
}

const NONE: Capabilities = {
  auth: { password: true, github: false, google: false, gitlab: false },
  git: { github: false, gitlab: false, bitbucket: false },
  payments: { enabled: false, stripe: false, paypal: false, mobileMoney: false },
  email: { delivery: false, verificationRequired: false },
  support: { email: null },
  maintenance: { enabled: false },
};

/** What this installation can do. Until it loads, everything optional is treated as unavailable. */
export function useCapabilities(): Capabilities {
  const q = useQuery({ queryKey: ["capabilities"], queryFn: () => get<Capabilities>("/capabilities"), staleTime: 60_000, refetchInterval: 120_000 });
  return q.data ?? NONE;
}
