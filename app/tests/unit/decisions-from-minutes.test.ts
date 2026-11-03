import { describe, expect, it } from 'vitest';
import { decisionInputOfMinutesItem, decisionTextsOf, minutesItemToken } from '../../src/server/decisions/from-minutes.js';
import { DECISION_APP_LINK, DECISION_CLIENT_TOKEN, DECISION_LIMITS, isDecisionDate } from '../../src/shared/decisions.js';

// A decision item of a confirmed meeting becomes the register's input on the server. Synthetic text only.

const MEETING = { id: 'mt_0123456789abcdef', title: '合成の役員会', heldOn: '2026-11-02' };

describe('the token of a minutes item', () => {
  it('names the meeting and the item, is one the server accepts, and is the same every time', () => {
    const token = minutesItemToken(MEETING.id, 3);
    expect(token).toBe('minutes-mt_0123456789abcdef-3');
    expect(DECISION_CLIENT_TOKEN.test(token)).toBe(true);
    expect(minutesItemToken(MEETING.id, 3)).toBe(token);
    expect(minutesItemToken(MEETING.id, 4)).not.toBe(token);
  });
});

describe('the title and body of an item', () => {
  it('keeps a short item whole in the title and leaves the body empty', () => {
    expect(decisionTextsOf('協賛の依頼文は総務部が作る')).toEqual({ title: '協賛の依頼文は総務部が作る', body: '' });
  });

  it('puts the part beyond the title limit into the body, so nothing is lost', () => {
    const text = `${'あ'.repeat(DECISION_LIMITS.title)}い${'う'.repeat(50)}`;
    const { title, body } = decisionTextsOf(text);
    expect(title).toHaveLength(DECISION_LIMITS.title);
    expect(body).toBe(`い${'う'.repeat(50)}`);
    expect(title + body).toBe(text);
  });

  it('makes one line of the text first, so a line break does not split the title', () => {
    expect(decisionTextsOf('一行目\n二行目\u0001の続き')).toEqual({ title: '一行目 二行目 の続き', body: '' });
  });
});

describe('the register input of an item', () => {
  it('takes the day and the place of the meeting, and names the meeting as its source', () => {
    const input = decisionInputOfMinutesItem(MEETING, '来場者向けパンフレットは 2,500 部刷る', ['planning'], 'board');
    expect(input).toMatchObject({
      title: '来場者向けパンフレットは 2,500 部刷る',
      body: '',
      departments: ['planning'],
      decidedOn: '2026-11-02',
      venue: 'board',
      venueOther: '',
      taskIds: [],
    });
    expect(input.sources).toEqual([{ kind: 'minutes', refId: MEETING.id, label: '議事録：合成の役員会', link: '#/bot/minutes?job=mt_0123456789abcdef' }]);
    expect(DECISION_APP_LINK.test(input.sources[0]!.link!)).toBe(true);
    expect(isDecisionDate(input.decidedOn)).toBe(true);
  });
});
