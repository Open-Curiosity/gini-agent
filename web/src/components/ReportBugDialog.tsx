"use client";

// In-app bug reporter. Collects a short freeform description plus a
// couple of optional context fields, attaches whatever runtime info is on
// hand (package version, git sha, instance, page), and shells out to a
// prefilled GitHub new-issue URL on the Lilac-Labs/gini-agent repo. The
// "Copy" button is a fallback for users who'd rather paste the report
// into Slack or grab it before logging into GitHub.

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useStatus } from "@/lib/queries";
import {
  buildIssueUrl,
  formatIssueBody,
  isReportSubmittable,
  type BugReportContext,
  type BugReportInput
} from "@/lib/bug-report";

const EMPTY_INPUT: BugReportInput = {
  title: "",
  whatHappened: "",
  stepsToReproduce: "",
  expected: ""
};

export interface ReportBugDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReportBugDialog({ open, onOpenChange }: ReportBugDialogProps) {
  const pathname = usePathname();
  const status = useStatus();
  const [input, setInput] = useState<BugReportInput>(EMPTY_INPUT);
  // navigator.userAgent only exists in the browser; capture it once the
  // dialog opens so SSR doesn't trip on it. Re-read each open in case
  // the user lands here from a different runtime (e.g. PWA reinstall).
  const [userAgent, setUserAgent] = useState<string>("");

  useEffect(() => {
    if (open) {
      setInput(EMPTY_INPUT);
      setUserAgent(typeof navigator !== "undefined" ? navigator.userAgent : "");
    }
  }, [open]);

  const context = useMemo<BugReportContext>(() => {
    const version = status.data?.version;
    return {
      packageVersion: version?.packageVersion,
      gitShortSha: version?.git.shortSha ?? null,
      gitBranch: version?.git.branch ?? null,
      instance: status.data?.instance,
      page: pathname ?? undefined,
      userAgent: userAgent || undefined,
      reportedAt: new Date().toISOString()
    };
  }, [status.data, pathname, userAgent]);

  const submittable = isReportSubmittable(input);
  // The full body is also what the "Copy" button hands back to the user,
  // so build it once and reuse for both flows.
  const previewBody = useMemo(() => formatIssueBody(input, context), [input, context]);

  function setField<K extends keyof BugReportInput>(key: K, value: BugReportInput[K]) {
    setInput((prev) => ({ ...prev, [key]: value }));
  }

  function openIssue() {
    if (!submittable) return;
    const url = buildIssueUrl(input, context);
    window.open(url, "_blank", "noopener,noreferrer");
    toast.success("Opening GitHub issue…");
    onOpenChange(false);
  }

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(previewBody);
      toast.success("Report copied to clipboard");
    } catch {
      toast.error("Couldn't copy. Select the text manually.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Report a bug</DialogTitle>
          <DialogDescription>
            Opens a prefilled issue on the{" "}
            <a
              href="https://github.com/Lilac-Labs/gini-agent/issues"
              target="_blank"
              rel="noopener noreferrer"
            >
              Lilac-Labs/gini-agent
            </a>{" "}
            repo. Version and page info are attached automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="bug-title">Title</Label>
            <Input
              id="bug-title"
              value={input.title}
              onChange={(e) => setField("title", e.target.value)}
              placeholder="Short summary (optional)"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bug-what">What happened? *</Label>
            <Textarea
              id="bug-what"
              value={input.whatHappened}
              onChange={(e) => setField("whatHappened", e.target.value)}
              placeholder="What broke? Any error messages?"
              rows={4}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bug-steps">Steps to reproduce</Label>
            <Textarea
              id="bug-steps"
              value={input.stepsToReproduce}
              onChange={(e) => setField("stepsToReproduce", e.target.value)}
              placeholder={"1. Open chat\n2. ..."}
              rows={3}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bug-expected">Expected behavior</Label>
            <Textarea
              id="bug-expected"
              value={input.expected}
              onChange={(e) => setField("expected", e.target.value)}
              placeholder="What did you expect to happen?"
              rows={2}
            />
          </div>
          <div className="rounded-md border border-border bg-muted/40 p-2 text-[11px] text-muted-foreground">
            <div className="mb-1 font-medium text-foreground">Will attach</div>
            <ul className="space-y-0.5">
              {context.packageVersion ? <li>Version {context.packageVersion}</li> : null}
              {context.gitShortSha ? (
                <li>
                  Commit {context.gitShortSha}
                  {context.gitBranch ? ` (branch ${context.gitBranch})` : ""}
                </li>
              ) : null}
              {context.instance ? <li>Instance {context.instance}</li> : null}
              {context.page ? <li>Page {context.page}</li> : null}
              {context.userAgent ? <li className="truncate" title={context.userAgent}>UA {context.userAgent}</li> : null}
            </ul>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={copyReport}>
            Copy report
          </Button>
          <Button onClick={openIssue} disabled={!submittable}>
            <ExternalLink className="h-3.5 w-3.5" />
            Open issue on GitHub
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
