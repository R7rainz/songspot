import { Link, useRouteError } from "react-router-dom";
import { EqualizerMark } from "../components/EqualizerMark";

// Replaces React Router's default "Hey developer" screen with something on-brand
// and useful when a route throws or a page can't be found.
export function ErrorPage() {
  const error = useRouteError() as
    | { status?: number; statusText?: string; message?: string }
    | undefined;
  const notFound = error?.status === 404;

  return (
    <main
      className="grid min-h-full place-items-center p-8"
      style={{
        background:
          "radial-gradient(120% 80% at 50% 0%, #14161f, var(--color-bg) 60%)",
      }}
    >
      <div className="flex max-w-[400px] flex-col items-center gap-3.5 text-center">
        <EqualizerMark size={28} />
        <h2 className="display display-sm">
          {notFound ? "This page skipped a beat" : "The music stopped"}
        </h2>
        <p className="text-muted">
          {notFound
            ? "We couldn't find that page."
            : "Something went wrong on our end. Reloading usually gets the set going again."}
        </p>
        <div className="mt-1.5 flex gap-2.5">
          <button className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
          <Link className="btn btn-primary" to="/">
            Back to start
          </Link>
        </div>
      </div>
    </main>
  );
}
