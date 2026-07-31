'use strict';

export function build(meeting) {
  return JSON.stringify(meeting, null, 2);
}
