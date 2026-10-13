import { Link } from "@tanstack/react-router";
import { ContactLink, LegalLayout, LegalSection } from "./LegalLayout";

const linkClass = "font-medium text-primary underline-offset-4 hover:underline";

/** The user data deletion instructions at `/data-deletion`. */
export function DataDeletionPage() {
  return (
    <LegalLayout
      title="Data deletion"
      summary={
        <>
          You can remove Loomcast's access to your accounts and have the data it stored about you
          deleted at any time. This page explains the three ways to do it, what is deleted and how
          long it takes.
        </>
      }
    >
      <LegalSection id="disconnect" title="1. Disconnect the account in Loomcast">
        <p>If you are a member of the Loomcast team:</p>
        <ol>
          <li>Sign in to Loomcast.</li>
          <li>
            Open <strong>Settings → Channels</strong>.
          </li>
          <li>
            Choose the Facebook Page, Instagram account, Threads profile or X account, then choose{" "}
            <strong>Disconnect</strong>.
          </li>
        </ol>
        <p>
          The stored access token is deleted straight away, and Loomcast stops publishing to the
          account and reading its insights.
        </p>
      </LegalSection>

      <LegalSection id="remove-the-app" title="2. Remove Loomcast in the platform's settings">
        <p>You can withdraw access from the platform's side without signing in to Loomcast:</p>
        <ul>
          <li>
            <strong>Facebook and Instagram:</strong> in Facebook, open{" "}
            <strong>Settings & privacy → Settings → Business integrations</strong>, select Loomcast
            and choose <strong>Remove</strong>. The Instagram account is connected through its
            Facebook Page, so this removes Loomcast's access to both.
          </li>
          <li>
            <strong>Threads:</strong> in the Threads app, open{" "}
            <strong>Settings → Account → Website permissions</strong>, select Loomcast under{" "}
            <strong>Active</strong> and choose <strong>Remove</strong>.
          </li>
          <li>
            <strong>X:</strong> open{" "}
            <strong>
              Settings → Security and account access → Apps and sessions → Connected apps
            </strong>
            , select Loomcast and choose <strong>Revoke app permissions</strong>.
          </li>
        </ul>
        <p>
          The token Loomcast holds stops working at once, so it can no longer publish to or read
          from the account. To have the records Loomcast already stored deleted as well, also send
          us a request as described below.
        </p>
      </LegalSection>

      <LegalSection id="request" title="3. Ask us to delete your data">
        <p>
          Email <ContactLink /> with the subject "Data deletion request". Tell us the name of the
          Page, account or profile (and, if you have it, its ID or username) so we can find the
          right records. We may ask you to confirm the request from the account itself, so that
          nobody else can delete your data.
        </p>
        <p>We confirm when we receive the request and again when the deletion is complete.</p>
      </LegalSection>

      <LegalSection id="what-is-deleted" title="What is deleted">
        <ul>
          <li>Access and refresh tokens for the account.</li>
          <li>The account, Page or profile identifiers and names Loomcast stored.</li>
          <li>
            Loomcast's copies of the posts published to that account: videos, thumbnails, captions
            and the links the platform returned.
          </li>
          <li>The insights Loomcast read about those posts.</li>
          <li>
            If you are a Loomcast team member and ask for it, your Loomcast account: name, email
            address, password hash and sessions.
          </li>
        </ul>
        <p>
          Posts that were already published stay on Facebook, Instagram, Threads or X until you
          delete them there; Loomcast cannot remove them once its access is gone. We keep a short
          note that the request was carried out, and anything the law requires us to keep.
        </p>
      </LegalSection>

      <LegalSection id="when" title="When it happens">
        <ul>
          <li>
            <strong>Disconnecting in Loomcast:</strong> the token is deleted immediately.
          </li>
          <li>
            <strong>A deletion request:</strong> the data above is deleted from Loomcast's server
            and storage within 30 days of the request being confirmed.
          </li>
          <li>
            <strong>Backups:</strong> database backups are encrypted and expire automatically, so
            any copy of the data in them is gone within 90 days of the backup being made.
          </li>
        </ul>
        <p>
          More about what Loomcast stores and why is in the{" "}
          <Link to="/privacy" className={linkClass}>
            privacy policy
          </Link>
          .
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
