import { Button } from "@loomcast/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@loomcast/ui/components/dropdown-menu";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { CREATABLE_KINDS, KIND_META } from "./kinds";

/** "New entry" with a choice of kind. */
export function NewEntryMenu({ projectParam }: { projectParam: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <PlusIcon aria-hidden="true" />
          New entry
          <ChevronDownIcon aria-hidden="true" className="opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {CREATABLE_KINDS.map((kind) => {
          const meta = KIND_META[kind];
          return (
            <DropdownMenuItem key={kind} asChild>
              <Link
                to="/projects/$projectId/kb/new"
                params={{ projectId: projectParam }}
                search={{ kind }}
              >
                <meta.icon aria-hidden="true" />
                {meta.label}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The button an empty list offers for its kind. */
export function NewEntryButton({
  projectParam,
  kind,
  label,
}: {
  projectParam: string;
  kind: (typeof CREATABLE_KINDS)[number];
  label: string;
}) {
  return (
    <Button asChild>
      <Link to="/projects/$projectId/kb/new" params={{ projectId: projectParam }} search={{ kind }}>
        <PlusIcon aria-hidden="true" />
        {label}
      </Link>
    </Button>
  );
}
