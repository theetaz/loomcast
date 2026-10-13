import { Link } from "@tanstack/react-router";
import { LEGAL_OPERATOR, LEGAL_SITE_URL } from "./contact";
import { ContactLink, LegalLayout, LegalSection } from "./LegalLayout";

const linkClass = "font-medium text-primary underline-offset-4 hover:underline";

/** The privacy policy at `/privacy`. */
export function PrivacyPage() {
  return (
    <LegalLayout
      title="Privacy policy"
      summary={
        <>
          This policy explains what information Loomcast keeps, why it keeps it, who else handles it
          and how you can have it removed. Loomcast is a small, private tool, so the list is short.
        </>
      }
    >
      <LegalSection id="who-we-are" title="Who we are">
        <p>
          Loomcast is operated by {LEGAL_OPERATOR} at {LEGAL_SITE_URL}. It is an invite-only tool
          that a small team (the owner and a few administrators they invite) uses to write, render
          and publish short videos to their own Facebook Pages, Instagram professional accounts,
          Threads profiles and, if they choose, X accounts.
        </p>
        <p>
          There is no public sign-up. Nobody outside the team can create an account, and Loomcast
          never publishes to an account that a team member has not connected themselves.
        </p>
      </LegalSection>

      <LegalSection id="what-we-collect" title="What we collect">
        <p>Loomcast stores only what it needs to publish and to report on what it published:</p>
        <ul>
          <li>
            <strong>Your Loomcast account.</strong> Your name, email address and a hashed form of
            your password (never the password itself). While you are signed in we also keep a
            session record with the IP address and browser it came from, so we can protect your
            account.
          </li>
          <li>
            <strong>Access tokens.</strong> When you connect an account, the platform gives Loomcast
            an access token (and for some platforms a refresh token). Tokens are encrypted before
            they are stored and are only decrypted on the server to make the calls you asked for.
          </li>
          <li>
            <strong>Account and Page details.</strong> The identifiers and names of the Facebook
            Pages, Instagram accounts, Threads profiles and X accounts you connect, so Loomcast
            knows where to publish and can show you which account is which.
          </li>
          <li>
            <strong>The posts it publishes.</strong> The videos, captions, thumbnails and schedule
            of each post, and the identifier and link the platform returns once it is published.
          </li>
          <li>
            <strong>Post insights.</strong> Figures the platforms report about the posts Loomcast
            published, such as views, plays, reach, likes, comments, shares and saves.
          </li>
          <li>
            <strong>Server logs.</strong> Short technical records of requests (time, path, status
            and the IP address) used to keep the service secure and to fix problems.
          </li>
        </ul>
        <p>
          Loomcast does not read your private messages, your followers' personal profiles, your
          friends list or anything else outside the permissions listed below.
        </p>
      </LegalSection>

      <LegalSection id="permissions" title="Permissions we ask for">
        <p>When you connect an account, the platform asks you to allow these permissions:</p>
        <ul>
          <li>
            <strong>Facebook Pages:</strong> <code>pages_show_list</code>,{" "}
            <code>pages_read_engagement</code>, <code>pages_manage_posts</code>,{" "}
            <code>read_insights</code> and <code>business_management</code>, to list the Pages you
            manage, publish videos to the Page you choose and read the insights of those posts.
          </li>
          <li>
            <strong>Instagram:</strong> <code>instagram_basic</code>,{" "}
            <code>instagram_content_publish</code> and <code>instagram_manage_insights</code>, to
            identify the professional account linked to your Page, publish Reels to it and read the
            insights of those Reels.
          </li>
          <li>
            <strong>Threads:</strong> <code>threads_basic</code>,{" "}
            <code>threads_content_publish</code> and <code>threads_manage_insights</code>, to
            identify your profile, publish posts to it and read the insights of those posts.
          </li>
          <li>
            <strong>X (optional):</strong> <code>tweet.read</code>, <code>tweet.write</code>,{" "}
            <code>users.read</code>, <code>media.write</code> and <code>offline.access</code>, to
            identify your account, upload videos, publish posts and keep the connection working
            without signing in again.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="how-we-use-it" title="How we use it">
        <ul>
          <li>To publish the posts your team prepared and approved, at the time you chose.</li>
          <li>To show you whether each post went out and how it is performing.</li>
          <li>
            To keep connections working: once a day the server checks that each token still works
            and renews tokens that are about to expire.
          </li>
          <li>To secure the service, investigate problems and keep an audit trail of changes.</li>
        </ul>
        <p>
          We do not sell, rent or trade your information. Loomcast shows no ads, does not build
          advertising profiles and does not pass platform data to advertisers or data brokers.
        </p>
      </LegalSection>

      <LegalSection id="where-it-is-stored" title="Where it is stored and who handles it">
        <ul>
          <li>
            <strong>Hetzner Online</strong> hosts the Loomcast server and its database in a data
            centre in Nuremberg, Germany.
          </li>
          <li>
            <strong>Cloudflare</strong> stores videos, thumbnails and encrypted database backups in
            its R2 object storage, and carries network traffic to the site.
          </li>
          <li>
            <strong>Meta and X</strong> receive the posts you publish to their platforms and return
            the insights about them. What they do with that content is covered by their own
            policies.
          </li>
        </ul>
        <p>
          These providers process the data only to provide their service to us. We do not share your
          information with anyone else unless the law requires us to.
        </p>
      </LegalSection>

      <LegalSection id="security" title="How we protect it">
        <p>
          The site is served only over HTTPS. Access tokens are encrypted at rest, passwords are
          stored as salted hashes, and only signed-in members of the team can see connected
          accounts, posts and insights. Access to the server itself is limited to the operator.
        </p>
      </LegalSection>

      <LegalSection id="retention" title="How long we keep it">
        <ul>
          <li>
            A connected account's details, posts and insights are kept while the team uses Loomcast,
            so past results stay available.
          </li>
          <li>
            Disconnecting a channel deletes its stored token straight away. Loomcast can no longer
            publish to it or read from it.
          </li>
          <li>
            When you ask us to delete your data, we remove it within 30 days. Encrypted backup
            copies expire automatically and are gone within 90 days of being made.
          </li>
          <li>Session records end when you sign out or the session expires.</li>
        </ul>
        <p>
          The{" "}
          <Link to="/data-deletion" className={linkClass}>
            data deletion page
          </Link>{" "}
          explains how to ask for deletion and exactly what is removed.
        </p>
      </LegalSection>

      <LegalSection id="your-rights" title="Your choices and rights">
        <p>
          You can disconnect any account in Loomcast at any time, or remove Loomcast's access from
          the platform's own settings. You can also ask us for a copy of the information we hold
          about you, ask us to correct it, or ask us to delete it. If you are in the European
          Economic Area or the United Kingdom you also have the right to object to or restrict
          processing and to complain to your data protection authority.
        </p>
      </LegalSection>

      <LegalSection id="children" title="Children">
        <p>
          Loomcast is a work tool for invited adults. It is not meant for children and we do not
          knowingly collect information about them.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes to this policy">
        <p>
          If we change this policy we will update the effective date at the top of this page and
          tell the team before the change applies if it affects how their data is used.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>
          Questions or requests about your data: write to <ContactLink />.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
