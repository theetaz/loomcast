import { Link } from "@tanstack/react-router";
import { LEGAL_OPERATOR } from "./contact";
import { ContactLink, LegalLayout, LegalSection } from "./LegalLayout";

const linkClass = "font-medium text-primary underline-offset-4 hover:underline";

/** The terms of service at `/terms`. */
export function TermsPage() {
  return (
    <LegalLayout
      title="Terms of service"
      summary={
        <>
          These terms set out how Loomcast may be used. By signing in or connecting an account you
          agree to them. In these terms, "we" means {LEGAL_OPERATOR} and "you" means the person
          using Loomcast.
        </>
      }
    >
      <LegalSection id="the-service" title="The service">
        <p>
          Loomcast is an invite-only tool for writing, rendering and publishing short videos to the
          Facebook Pages, Instagram professional accounts, Threads profiles and X accounts that its
          users connect. It is run for a small team; there is no public sign-up and no paid plan.
        </p>
      </LegalSection>

      <LegalSection id="accounts" title="Your account">
        <ul>
          <li>Accounts are created only by invitation from the workspace owner or an admin.</li>
          <li>
            Your account is for you alone. Keep your password and any access tokens you create
            private, and tell us at once if you think someone else has used them.
          </li>
          <li>The owner can change your role or remove your account at any time.</li>
        </ul>
      </LegalSection>

      <LegalSection id="connected-accounts" title="Connected accounts">
        <ul>
          <li>
            Only connect Pages, profiles and accounts that you own or are authorised to manage.
          </li>
          <li>
            By connecting an account you allow Loomcast to publish the posts your team approves to
            it and to read the insights of those posts, within the permissions you granted.
          </li>
          <li>
            Your use of each platform stays subject to that platform's own terms and policies,
            including those of Meta (Facebook, Instagram and Threads) and X.
          </li>
          <li>
            You can disconnect an account in Loomcast or remove Loomcast's access in the platform's
            settings at any time.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="your-content" title="Your content">
        <p>
          You keep ownership of the scripts, videos, captions and other material you create or
          upload. You give us permission to store, process, render and publish that material only as
          needed to run Loomcast for you.
        </p>
        <p>
          You are responsible for what you publish. Make sure you have the rights to every piece of
          footage, music, image and text you use, and that each post follows the law and the rules
          of the platform it goes to.
        </p>
      </LegalSection>

      <LegalSection id="acceptable-use" title="Acceptable use">
        <p>Do not use Loomcast to:</p>
        <ul>
          <li>publish spam, misleading content or anything unlawful, hateful or harassing;</li>
          <li>infringe anyone's copyright, trademark, privacy or other rights;</li>
          <li>get around a platform's rate limits, rules or technical restrictions;</li>
          <li>
            try to break into, overload or disrupt Loomcast, or reach data you are not allowed to
            see.
          </li>
        </ul>
        <p>We may suspend access that breaks these rules, and remove the material involved.</p>
      </LegalSection>

      <LegalSection id="availability" title="Availability and changes">
        <p>
          We work to keep Loomcast running and secure, but we cannot promise it will always be
          available or free of errors. Publishing depends on the platforms, which can change their
          services, delay posts or refuse them. We may change, pause or retire features, and we will
          tell the team in advance when we reasonably can.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="Disclaimer and liability">
        <p>
          Loomcast is provided "as is". To the extent the law allows, we give no warranties about it
          and we are not liable for indirect or consequential losses, such as lost profits, lost
          followers or a post that a platform delays or removes. Nothing in these terms limits
          liability that cannot be limited by law.
        </p>
      </LegalSection>

      <LegalSection id="ending" title="Ending your use">
        <p>
          You can stop using Loomcast at any time by disconnecting your accounts and asking the
          owner to remove your account. To have your data deleted as well, follow the steps on the{" "}
          <Link to="/data-deletion" className={linkClass}>
            data deletion page
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection id="privacy" title="Privacy">
        <p>
          The{" "}
          <Link to="/privacy" className={linkClass}>
            privacy policy
          </Link>{" "}
          explains what information Loomcast keeps and how it is used. It forms part of these terms.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes to these terms">
        <p>
          We may update these terms. When we do, we change the effective date above and tell the
          team about significant changes. Using Loomcast after a change means you accept the new
          terms.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>
          Questions about these terms: write to <ContactLink />.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
