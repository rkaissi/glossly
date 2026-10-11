/** A saved calendar event (Step 19.2), stored on this computer only. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** "YYYY-MM-DD" when all day, else an ISO timestamp with the local offset. */
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  location: string | null;
  /** Everyone attending as written, saved or not. */
  attendees: string[];
  /** The saved people among them. */
  people: { id: string; name: string }[];
  source_app: string | null;
  created_at: string;
}

/** A candidate event in the panel, before the user saves it. */
export interface EventCandidate {
  key: string;
  title: string;
  /** Null when the day couldn't be read; the user picks one. */
  starts_at: string | null;
  ends_at: string | null;
  all_day: boolean;
  /** The day and time as written, for the tooltip. */
  when_phrase: string | null;
  location: string | null;
  attendees: string[];
  /** Attendees who resolved to a saved person exactly. */
  people: { personId: string; name: string }[];
  confidence: number;
  selected: boolean;
}

/** A reviewed row to save. */
export interface EventSaveRow {
  title: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  location: string | null;
  attendees: string[];
  personIds: string[];
}

export interface EventPatch {
  title?: string;
  starts_at?: string;
  ends_at?: string | null;
  all_day?: boolean;
  location?: string | null;
}
