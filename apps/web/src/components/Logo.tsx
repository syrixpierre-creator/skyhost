import { cx } from "./ui";

/** The SKYHOST mark (from the brand logo) with the wordmark set in the interface font, so it reads on black and white. */
export function Logo({ size = "md", className, wordmark = true }: { size?: "sm" | "md" | "lg"; className?: string; wordmark?: boolean }) {
  const mark = size === "lg" ? "size-10" : size === "sm" ? "size-6" : "size-7";
  const text = size === "lg" ? "text-2xl" : size === "sm" ? "text-sm" : "text-base";
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      <img src="/brand/skyhost-mark-192.png" alt="" className={cx(mark, "object-contain")} />
      {wordmark && <span className={cx("font-semibold tracking-[-0.03em]", text)}>SKYHOST</span>}
    </span>
  );
}
