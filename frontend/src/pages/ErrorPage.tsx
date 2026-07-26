import { Link, useRouteError } from "react-router-dom";
import { EqualizerMark } from "../components/EqualizerMark";
import { NoteField } from "../components/Brand";

// Replaces React Router's default "Hey developer" screen with something on-brand
// and useful when a route throws or a page can't be found.
export function ErrorPage() {
  const error = useRouteError() as
    | { status?: number; statusText?: string; message?: string }
    | undefined;
  const notFound = error?.status === 404;

  return (
    <main className="relative grid min-h-full place-items-center overflow-hidden p-8">
      <NoteField />
      <div
        className="card relative flex max-w-[440px] flex-col items-center gap-3 text-center"
        role="alert"
      >
        <EqualizerMark size={30} />
        <h2 className="display display-sm">
          {notFound ? "This page skipped a beat" : "The music stopped"}
        </h2>
        <p className="text-[0.95rem] font-semibold text-ink2">
          {notFound
            ? "We couldn't find that page."
            : "Something went wrong on our end. Reloading usually gets the set going again."}
        </p>
        <div className="mt-1.5 flex flex-wrap justify-center gap-2.5">
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
