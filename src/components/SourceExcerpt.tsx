import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { SourceCitation } from "@/integrations/supabase/chat";

interface SourceExcerptProps {
  source: SourceCitation;
  documentName?: string;
}

const SourceExcerpt = ({ source, documentName }: SourceExcerptProps) => {
  const [expanded, setExpanded] = useState(false);
  const fullExcerpt = source.fullExcerpt || source.excerpt;
  const expandable = fullExcerpt !== source.excerpt;

  return (
    <div className="text-xs text-muted-foreground">
      <p className="font-medium text-foreground">
        {documentName ? `${documentName} · ` : ""}Page {source.pageNumber}
      </p>
      <p className="mt-1 whitespace-pre-wrap">{expanded ? fullExcerpt : source.excerpt}</p>
      {expandable && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-0 py-1 text-xs"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Hide excerpt" : "Show full excerpt"}
        </Button>
      )}
    </div>
  );
};

export default SourceExcerpt;
