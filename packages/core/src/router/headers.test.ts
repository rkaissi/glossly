// The local header parser's fallback cases from the Step 20.4 review, on fictional Discord, Slack,
// and chat layouts.
import { describe, expect, it } from 'vitest';
import { detectPeople } from '../people/detect';
import { headers, knownName, lastSpeaker, speakers } from './features';

const me = { name: 'Alex Morgan', emails: [], handles: [] };
const names = (text: string, known = knownName(me)) => speakers(text, known);

describe('headers (Step 20.4 fixes)', () => {
  it('never takes a bare badge line for a speaker', () => {
    const text = ['JordanZ2', 'GEN2', '7:02 PM', 'what kind of job are you doing now?'].join('\n');
    expect(headers(text)).toEqual([{ line: 0, name: 'JordanZ2' }]);
    expect(lastSpeaker(`Alex\n8/31/26, 9:10 PM\nim in the city for work rn\n${text}\n`)).toBe('JordanZ2');
  });

  it('reads a display name with spaces alone on its line', () => {
    expect(names(['Casey Lin', '7:34 PM', 'running late, five minutes'].join('\n'))).toEqual(['Casey Lin']);
    expect(names(['Mary Ann Fox', 'Today at 9:02 AM', 'morning!'].join('\n'))).toEqual(['Mary Ann Fox']);
    // Lowercase or extra words only when already seen: the user, a saved person, or an earlier speaker.
    expect(names(['alex morgan', '7:34 PM', 'on my way'].join('\n'))).toEqual(['alex morgan']);
    expect(names(['casey lin', '7:34 PM', 'on my way'].join('\n'), knownName(me, [{ name: 'Casey Lin', aliases: [] }]))).toEqual(['casey lin']);
    expect(names(['see you soon', '7:34 PM', 'ok'].join('\n'))).toEqual([]);
    expect(names(['Team Sync', '3:00 PM', 'agenda below'].join('\n'))).toEqual([]);
  });

  it('never takes a weekday, month, or date line for a speaker', () => {
    expect(names(['Friday', '3:00 PM', 'Casey', '3:01 PM', 'see you then'].join('\n'))).toEqual(['Casey']);
    expect(names(['Yesterday', '9:15 AM', 'hello'].join('\n'))).toEqual([]);
    expect(names(['October 9, 2026', 'Jordan', '9:15 AM', 'hello'].join('\n'))).toEqual(['Jordan']);
    expect(names(['Fri, Oct 9', '9:15 AM', 'hello'].join('\n'))).toEqual([]);
    expect(names('Friday 3:00 PM\nhello')).toEqual([]);
    // A month that is also a name is still a name with a surname.
    expect(names(['May Chen', '9:15 AM', 'hello'].join('\n'))).toEqual(['May Chen']);
  });

  it('does not turn a short line above a hover timestamp into a speaker', () => {
    const text = ['JordanZ2', 'Server Tag: GEN2', '8:02 PM', 'working too', 'lol', '8:03 PM', 'it is a startup'].join('\n');
    expect(names(text)).toEqual(['JordanZ2']);
    expect(lastSpeaker(`${text}\n`)).toBe('JordanZ2');
    // An earlier speaker on that spot is a real header.
    expect(names(['quinn', '3:12 PM', 'hey', 'Alex', '3:14 PM', 'hi', 'quinn', '3:15 PM', 'ok'].join('\n'))).toEqual(['quinn', 'Alex', 'quinn']);
  });

  it('keeps a header whose message is past the end of the captured text', () => {
    expect(lastSpeaker('Alex\n7:34 PM\nhey\nJordanZ2\nServer Tag: GEN2\n8:02 PM\n')).toBe('JordanZ2');
  });

  it('finds the real author for Reply on Discord with a bare badge', () => {
    const before = ['Alex', '7:34 PM', 'are you working this term?', 'JordanZ2', 'GEN2', '8:02 PM', ''].join('\n');
    const d = detectPeople({ text: 'working too, at a lab supply company', before, after: '', source_app: 'discord.exe', window_title: 'Discord' }, me);
    expect(d.author?.name).toBe('JordanZ2');
    expect(d.authorIsMe).toBe(false);
  });
});
