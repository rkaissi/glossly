// What each kind of saved item is called (decision 84); the same words as core's ITEM_KIND_LABEL,
// kept here because the UI imports no core code.
import type { LibraryItem } from '@glossly/core/api';

export const KIND_LABEL: Record<LibraryItem['kind'], string> = { selection: 'Snippet', link: 'Link', chart: 'Chart', note: 'Memory' };
export const KIND_PLURAL: Record<LibraryItem['kind'], string> = { selection: 'Snippets', link: 'Links', chart: 'Charts', note: 'Memories' };
/** The order the Saved tab's type filters come in. */
export const KIND_ORDER: LibraryItem['kind'][] = ['selection', 'link', 'chart', 'note'];
