import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Invite } from "../lib/types";

interface Props {
  roomID: string;
}

export function InvitePanel({ roomID }: Props) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = invite
    ? `${location.origin}/join/${invite.token}`
    : `${location.origin}/room/${roomID}`;

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setInvite(await api.createInvite(roomID));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't make an invite.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Couldn't copy — select the link and copy it manually.");
    }
  }

  return (
    <div className="invite">
      <div className="invite__row">
        <input className="input input--mono" readOnly value={link} />
        <button className="btn" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="invite__foot">
        <button className="btn btn--ghost" onClick={generate} disabled={busy}>
          {busy
            ? "Generating…"
            : invite
              ? "New invite link"
              : "Create invite link"}
        </button>
        {invite && (
          <span className="muted muted--sm">
            {invite.maxUses} uses · expires{" "}
            {new Date(invite.expiresAt).toLocaleString()}
          </span>
        )}
      </div>
      {error && <p className="alert alert--inline">{error}</p>}
    </div>
  );
}
