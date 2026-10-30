const CARD_ROWS = 3;
const CARD_SPAN = 6;
const COLUMNS_PER_ROUND = 3;

const COLORS = {
  ink: { red: 0.08, green: 0.15, blue: 0.12 },
  green: { red: 0.09, green: 0.37, blue: 0.24 },
  darkGreen: { red: 0.07, green: 0.25, blue: 0.18 },
  paleGreen: { red: 0.90, green: 0.96, blue: 0.91 },
  white: { red: 1, green: 1, blue: 1 },
  gold: { red: 1, green: 0.94, blue: 0.72 },
  soft: { red: 0.97, green: 0.98, blue: 0.97 },
  border: { red: 0.72, green: 0.79, blue: 0.75 },
  muted: { red: 0.43, green: 0.48, blue: 0.45 }
};

const TOURNAMENT_STATUS = {
  queued: 'Sẵn sàng',
  running: 'Đang diễn ra',
  completed: 'Hoàn tất',
  failed: 'Gặp lỗi',
  paused: 'Tạm dừng',
  cancelled: 'Đã hủy'
};

const MATCH_STATUS = {
  queued: 'Chờ đấu',
  running: 'Đang đấu…',
  completed: 'Hoàn tất',
  failed: 'Gặp lỗi',
  cancelled: 'Đã hủy'
};

const MODE_LABELS = {
  classic: '3v3 Nhanh',
  tactical: '6v6 Chiến thuật',
  army: '9v9 Đại chiến'
};

function cellRange(startRow, endRow, startColumn, endColumn) {
  return { startRow, endRow, startColumn, endColumn };
}

function textFormat(overrides = {}) {
  return { fontSize: 10, foregroundColor: COLORS.ink, ...overrides };
}

function style(range, options = {}) {
  const format = {};
  if (options.background) format.backgroundColor = options.background;
  if (options.textFormat) format.textFormat = options.textFormat;
  if (options.horizontalAlignment) format.horizontalAlignment = options.horizontalAlignment;
  if (options.verticalAlignment) format.verticalAlignment = options.verticalAlignment;
  if (options.wrapStrategy) format.wrapStrategy = options.wrapStrategy;
  if (options.numberFormat) format.numberFormat = options.numberFormat;
  return { range, format };
}

function border(range, color = COLORS.border, width = 1) {
  return { range, color, width };
}

function tournamentStatusLabel(status) {
  return TOURNAMENT_STATUS[status] || status || '';
}

function formatLabel(tournament) {
  if (tournament.format === 'swiss' || tournament.format === 'swiss-playoff') {
    const total = tournament.totalRounds || 1;
    const current = Math.min(tournament.currentRound || 1, total);
    let label = `${tournament.format === 'swiss-playoff' ? 'Swiss + top 32 playoff' : 'Swiss'} · vòng ${current}/${total}`;
    if (tournament.format === 'swiss-playoff' && (tournament.currentRound || 0) > total) {
      label += ` · playoff ${(tournament.currentRound || 0) - total}`;
    }
    return label;
  }
  if (tournament.format === 'single-elimination') return 'Loại trực tiếp';
  return 'Vòng tròn hai lượt';
}

function formatDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function matchStatusShort(match) {
  if (match.result?.bye || !match.p2BotId) return 'Miễn đấu';
  return MATCH_STATUS[match.status] || match.status || '';
}

function matchStatusLabel(match) {
  if (match.result?.bye || !match.p2BotId) return 'Miễn đấu';
  if (match.status === 'running') return 'Đang đấu…';
  if (match.status === 'queued') return 'Chờ đấu';
  if (match.status === 'completed') {
    if (match.result?.draw) return 'Hòa';
    return match.result?.turns ? `${match.result.turns} lượt` : 'Hoàn tất';
  }
  return MATCH_STATUS[match.status] || match.status || '';
}

function matchScore(match) {
  if (!match.result) return '–';
  if (match.result.bye || !match.p2BotId) return '1 – –';
  if (match.result.draw) return '½ – ½';
  if (!match.result.winnerBotId) return '–';
  return match.result.winnerBotId === match.p1BotId ? '1 – 0' : '0 – 1';
}

function matchResultLabel(match) {
  const result = match.result;
  if (!result) return '—';
  if (result.bye || !match.p2BotId) return 'Miễn đấu (+1 điểm)';
  if (result.draw) return 'Hòa';
  return result.winnerBotName ? `${result.winnerBotName} thắng` : '—';
}

function winnerSide(match) {
  if (!match.result?.winnerBotId) return 0;
  if (match.result.winnerBotId === match.p1BotId) return 1;
  if (match.result.winnerBotId === match.p2BotId) return 2;
  return 0;
}

function swissRounds(tournament) {
  return [...new Set((tournament.matches || [])
    .filter(match => (match.stage || 'swiss') === 'swiss' && Number.isInteger(match.round) && match.round > 0)
    .map(match => match.round))]
    .sort((a, b) => a - b);
}

function pageNames(tournament) {
  const pages = ['Tổng quan'];
  if (tournament.format === 'round-robin-two-legs') {
    pages.push('Vòng tròn');
  } else {
    pages.push(...swissRounds(tournament).map(round => `Vòng ${round}`));
  }
  pages.push('Playoff');
  return pages;
}

function buildOverviewTab(tournament) {
  const standings = tournament.standings || [];
  const rows = [
    [tournament.name || 'Giải đấu'],
    [],
    ['Thể thức', formatLabel(tournament)],
    ['Chế độ', MODE_LABELS[tournament.mode] || tournament.mode || ''],
    ['Trạng thái', tournamentStatusLabel(tournament.status)],
    ['Tiến độ', `${tournament.completedMatches || 0}/${(tournament.matches || []).length} trận`],
    ['Vòng hiện tại', tournament.currentRound ? `Vòng ${tournament.currentRound}` : '—'],
    ['Nhà vô địch', tournament.champion || '—'],
    ['Cập nhật', formatDateTime(tournament.updatedAt)],
    ['Các trang', pageNames(tournament).join(' · ')],
    [],
    ['Bảng xếp hạng'],
    ['Hạng', 'Bot', 'Trận', 'Thắng', 'Hòa', 'Thua', 'Miễn đấu', 'Điểm', 'Buchholz', 'Đối đầu']
  ];

  standings.forEach((row, index) => {
    rows.push([
      index + 1,
      row.name,
      row.played,
      row.wins,
      row.draws,
      row.losses,
      row.byes || 0,
      row.points,
      row.buchholz ?? 0,
      row.headToHeadPoints ?? 0
    ]);
  });
  if (!standings.length) rows.push(['—', 'Chưa có dữ liệu xếp hạng']);

  const styles = [
    style(cellRange(0, 1, 0, 10), {
      background: COLORS.darkGreen,
      textFormat: textFormat({ bold: true, fontSize: 18, foregroundColor: COLORS.white }),
      verticalAlignment: 'MIDDLE'
    }),
    style(cellRange(2, 10, 0, 1), {
      textFormat: textFormat({ bold: true, foregroundColor: COLORS.green }),
      verticalAlignment: 'MIDDLE'
    }),
    style(cellRange(2, 10, 1, 2), { verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' }),
    style(cellRange(11, 12, 0, 10), {
      background: COLORS.green,
      textFormat: textFormat({ bold: true, foregroundColor: COLORS.white })
    }),
    style(cellRange(12, 13, 0, 10), {
      background: COLORS.paleGreen,
      textFormat: textFormat({ bold: true, foregroundColor: COLORS.darkGreen }),
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE'
    })
  ];

  const standingsStart = 13;
  standings.forEach((row, index) => {
    if (index % 2 === 1) {
      styles.push(style(cellRange(standingsStart + index, standingsStart + index + 1, 0, 10), {
        background: COLORS.soft
      }));
    }
    if (index === 0 && tournament.champion) {
      styles.push(style(cellRange(standingsStart + index, standingsStart + index + 1, 0, 10), {
        textFormat: textFormat({ bold: true, foregroundColor: COLORS.green })
      }));
    }
  });
  if (!standings.length) {
    styles.push(style(cellRange(standingsStart, standingsStart + 1, 0, 10), {
      textFormat: textFormat({ foregroundColor: COLORS.muted })
    }));
  }

  return {
    title: 'Tổng quan',
    rows,
    merges: [
      cellRange(0, 1, 0, 10),
      cellRange(11, 12, 0, 10),
      ...Array.from({ length: 8 }, (_, index) => cellRange(2 + index, 3 + index, 1, 4))
    ],
    styles,
    borders: [],
    widths: [
      { startIndex: 0, endIndex: 1, pixelSize: 150 },
      { startIndex: 1, endIndex: 2, pixelSize: 230 },
      { startIndex: 2, endIndex: 8, pixelSize: 90 },
      { startIndex: 8, endIndex: 10, pixelSize: 110 }
    ],
    rowHeights: [{ startIndex: 0, endIndex: 1, pixelSize: 38 }],
    frozenRows: 1
  };
}

function buildRoundTab(tournament, round, matches) {
  const ordered = [...matches].sort((a, b) => a.id.localeCompare(b.id));
  const completed = ordered.filter(match => match.status === 'completed').length;
  const rows = [
    [`${tournament.name || 'Giải đấu'} · Vòng ${round}`],
    [],
    ['Trận', 'Bot 1', 'Tỷ số', 'Bot 2', 'Kết quả', 'Trạng thái', 'Số lượt', 'Replay']
  ];
  const styles = [
    style(cellRange(0, 1, 0, 8), {
      background: COLORS.darkGreen,
      textFormat: textFormat({ bold: true, fontSize: 16, foregroundColor: COLORS.white }),
      verticalAlignment: 'MIDDLE'
    }),
    style(cellRange(2, 3, 0, 8), {
      background: COLORS.paleGreen,
      textFormat: textFormat({ bold: true, foregroundColor: COLORS.darkGreen }),
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE'
    })
  ];

  ordered.forEach((match, index) => {
    const rowIndex = 3 + index;
    rows.push([
      index + 1,
      match.p1BotName || 'BYE',
      matchScore(match),
      match.p2BotName || 'BYE',
      matchResultLabel(match),
      matchStatusShort(match),
      match.result?.turns ?? '',
      match.result?.replayFile || ''
    ]);
    if (index % 2 === 1) {
      styles.push(style(cellRange(rowIndex, rowIndex + 1, 0, 8), { background: COLORS.soft }));
    }
    const winner = winnerSide(match);
    if (winner === 1) {
      styles.push(style(cellRange(rowIndex, rowIndex + 1, 1, 2), {
        textFormat: textFormat({ bold: true, foregroundColor: COLORS.green })
      }));
    } else if (winner === 2) {
      styles.push(style(cellRange(rowIndex, rowIndex + 1, 3, 4), {
        textFormat: textFormat({ bold: true, foregroundColor: COLORS.green })
      }));
    }
  });

  const summaryRow = 3 + ordered.length + 1;
  rows.push([]);
  rows.push([`Đã hoàn tất ${completed}/${ordered.length} trận`]);
  styles.push(style(cellRange(summaryRow, summaryRow + 1, 0, 8), {
    textFormat: textFormat({ italic: true, foregroundColor: COLORS.muted })
  }));

  return {
    title: `Vòng ${round}`,
    rows,
    merges: [cellRange(0, 1, 0, 8), cellRange(summaryRow, summaryRow + 1, 0, 8)],
    styles,
    borders: ordered.map((match, index) => border(cellRange(3 + index, 4 + index, 0, 8))),
    widths: [
      { startIndex: 0, endIndex: 1, pixelSize: 60 },
      { startIndex: 1, endIndex: 2, pixelSize: 210 },
      { startIndex: 2, endIndex: 3, pixelSize: 72 },
      { startIndex: 3, endIndex: 4, pixelSize: 210 },
      { startIndex: 4, endIndex: 5, pixelSize: 190 },
      { startIndex: 5, endIndex: 6, pixelSize: 110 },
      { startIndex: 6, endIndex: 7, pixelSize: 80 },
      { startIndex: 7, endIndex: 8, pixelSize: 210 }
    ],
    rowHeights: [],
    frozenRows: 3
  };
}

function buildRoundRobinTab(tournament) {
  return { ...buildRoundTab(tournament, 0, tournament.matches || []), title: 'Vòng tròn' };
}

function bracketRounds(matches, stage) {
  const rounds = new Map();
  for (const match of matches) {
    if ((match.stage || 'swiss') !== stage) continue;
    if (!rounds.has(match.round)) rounds.set(match.round, []);
    rounds.get(match.round).push(match);
  }
  return [...rounds.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, items]) => ({
      round,
      matches: [...items].sort((a, b) => a.id.localeCompare(b.id))
    }));
}

function bracketLayoutRows(rounds) {
  const layouts = [];
  rounds.forEach((round, roundIndex) => {
    const previousMatches = rounds[roundIndex - 1]?.matches || [];
    const previousLayout = layouts[roundIndex - 1] || [];
    const previousByBot = new Map();
    previousMatches.forEach((match, index) => {
      if (match.p1BotId) previousByBot.set(match.p1BotId, index);
      if (match.p2BotId) previousByBot.set(match.p2BotId, index);
    });

    const positions = round.matches.map((match, index) => {
      let feeds = [];
      if (roundIndex > 0) {
        for (const botId of [match.p1BotId, match.p2BotId]) {
          if (botId && previousByBot.has(botId)) feeds.push(previousByBot.get(botId));
        }
        feeds = [...new Set(feeds)];
        if (!feeds.length) {
          if (previousMatches.length === round.matches.length * 2) feeds = [index * 2, index * 2 + 1];
          else if (previousMatches.length === round.matches.length) feeds = [index];
          else if (previousMatches.length) feeds = [Math.min(index, previousMatches.length - 1)];
        }
      }
      const feedRows = feeds
        .map(feedIndex => previousLayout[feedIndex]?.row)
        .filter(value => Number.isFinite(value));
      const row = roundIndex === 0
        ? index * CARD_SPAN
        : (feedRows.length
          ? Math.round(feedRows.reduce((sum, value) => sum + value, 0) / feedRows.length)
          : index * CARD_SPAN);
      return { match, row, feeds };
    });
    layouts.push(positions);
  });
  return layouts;
}

function upperRoundLabel(index, bracketSize) {
  const teams = bracketSize / (2 ** index);
  if (teams <= 2) return 'Chung kết nhánh thắng';
  if (teams === 4) return 'Bán kết';
  if (teams === 8) return 'Tứ kết';
  return `Vòng 1/${teams / 2}`;
}

function lowerRoundLabel(index, total) {
  return index === total - 1 ? 'Chung kết nhánh thua' : `Vòng ${index + 1}`;
}

function ensureRow(rows, rowIndex, columnCount) {
  while (rows.length <= rowIndex) rows.push(new Array(columnCount).fill(''));
  while (rows[rowIndex].length < columnCount) rows[rowIndex].push('');
}

function put(rows, rowIndex, columnIndex, value, columnCount) {
  ensureRow(rows, rowIndex, columnCount);
  rows[rowIndex][columnIndex] = value;
}

function bracketScore(match, botId, bye) {
  if (bye || !match.result) return '–';
  if (match.result.draw) return '½';
  if (!match.result.winnerBotId) return '–';
  return match.result.winnerBotId === botId ? '1' : '0';
}

function bracketWinner(match, botId) {
  return Boolean(botId && match.result && !match.result.draw && match.result.winnerBotId === botId);
}

function buildPlayoffTab(tournament) {
  const matches = tournament.matches || [];
  const winners = bracketRounds(matches, 'winners');
  const losers = bracketRounds(matches, 'losers');
  const grandFinalMatch = bracketRounds(matches, 'grand-final')[0]?.matches?.[0] || null;

  if (!winners.length && !losers.length && !grandFinalMatch) {
    return {
      title: 'Playoff',
      rows: [
        [`${tournament.name || 'Giải đấu'} · Playoff`],
        [],
        ['Chưa có trận playoff.'],
        ['Sơ đồ sẽ xuất hiện khi giai đoạn playoff bắt đầu.']
      ],
      merges: [cellRange(0, 1, 0, 6)],
      styles: [
        style(cellRange(0, 1, 0, 6), {
          background: COLORS.darkGreen,
          textFormat: textFormat({ bold: true, fontSize: 16, foregroundColor: COLORS.white })
        }),
        style(cellRange(2, 4, 0, 6), {
          textFormat: textFormat({ foregroundColor: COLORS.muted }),
          wrapStrategy: 'WRAP'
        })
      ],
      borders: [],
      widths: [{ startIndex: 0, endIndex: 6, pixelSize: 160 }],
      rowHeights: [],
      frozenRows: 1
    };
  }

  const winnerLayouts = bracketLayoutRows(winners);
  const loserLayouts = bracketLayoutRows(losers);
  const hasWinners = winners.length > 0;
  const hasLosers = losers.length > 0;

  const winnersTop = 2;
  const winnerBottomRows = winnerLayouts.flat().map(position => winnersTop + position.row + CARD_ROWS);
  const winnersBottom = winnerBottomRows.length ? Math.max(...winnerBottomRows) : 0;
  const losersLabelRow = hasWinners ? winnersBottom + 1 : 0;
  const losersHeaderRow = losersLabelRow + 1;
  const losersTop = losersHeaderRow + 1;
  const loserBottomRows = loserLayouts.flat().map(position => losersTop + position.row + CARD_ROWS);
  const losersBottom = loserBottomRows.length ? Math.max(...loserBottomRows) : 0;

  const maxRounds = Math.max(winners.length, losers.length);
  const grandFinalColumn = maxRounds * COLUMNS_PER_ROUND;
  const maxColumn = grandFinalMatch ? grandFinalColumn + 2 : Math.max(2, maxRounds * COLUMNS_PER_ROUND);
  const winnerFinalPosition = winnerLayouts.flat().at(-1) || null;
  const loserFinalPosition = loserLayouts.flat().at(-1) || null;

  let grandFinalRow = null;
  if (grandFinalMatch) {
    const anchors = [];
    if (winnerFinalPosition) anchors.push(winnersTop + winnerFinalPosition.row);
    if (loserFinalPosition) anchors.push(losersTop + loserFinalPosition.row);
    const anchor = anchors.length
      ? anchors.reduce((sum, value) => sum + value, 0) / anchors.length
      : winnersTop;
    grandFinalRow = Math.max(0, Math.round(anchor));
  }

  const rows = [];
  const merges = [];
  const styles = [];
  const borders = [];

  if (hasWinners) {
    put(rows, 0, 0, 'Nhánh thắng', maxColumn);
    merges.push(cellRange(0, 1, 0, maxRounds * COLUMNS_PER_ROUND));
    styles.push(style(cellRange(0, 1, 0, maxRounds * COLUMNS_PER_ROUND), {
      background: COLORS.green,
      textFormat: textFormat({ bold: true, fontSize: 12, foregroundColor: COLORS.white }),
      verticalAlignment: 'MIDDLE'
    }));
  }
  if (hasLosers) {
    put(rows, losersLabelRow, 0, 'Nhánh thua', maxColumn);
    merges.push(cellRange(losersLabelRow, losersLabelRow + 1, 0, maxRounds * COLUMNS_PER_ROUND));
    styles.push(style(cellRange(losersLabelRow, losersLabelRow + 1, 0, maxRounds * COLUMNS_PER_ROUND), {
      background: COLORS.darkGreen,
      textFormat: textFormat({ bold: true, fontSize: 12, foregroundColor: COLORS.white }),
      verticalAlignment: 'MIDDLE'
    }));
  }

  function placeHeader(rowIndex, columnIndex, label) {
    put(rows, rowIndex, columnIndex, label, maxColumn);
    merges.push(cellRange(rowIndex, rowIndex + 1, columnIndex, columnIndex + 2));
    styles.push(style(cellRange(rowIndex, rowIndex + 1, columnIndex, columnIndex + 2), {
      background: COLORS.paleGreen,
      textFormat: textFormat({ bold: true, foregroundColor: COLORS.darkGreen }),
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
      wrapStrategy: 'WRAP'
    }));
  }

  winnerLayouts.forEach((positions, roundIndex) => {
    placeHeader(1, roundIndex * COLUMNS_PER_ROUND, upperRoundLabel(roundIndex, 2 ** winners.length));
  });
  loserLayouts.forEach((positions, roundIndex) => {
    placeHeader(losersHeaderRow, roundIndex * COLUMNS_PER_ROUND, lowerRoundLabel(roundIndex, losers.length));
  });

  function placeCard(position, topRow, columnIndex, layouts, roundIndex, stage) {
    const cardRow = topRow + position.row;
    const match = position.match;
    const isGrandFinal = stage === 'grand-final';
    const champion = isGrandFinal && match.result?.winnerBotName &&
      tournament.champion === match.result.winnerBotName;
    const p1Bye = !match.p1BotId || match.p1BotName === 'Bye';
    const p2Bye = !match.p2BotId || match.p2BotName === 'Bye';
    const p1Winner = !p1Bye && bracketWinner(match, match.p1BotId);
    const p2Winner = !p2Bye && bracketWinner(match, match.p2BotId);
    const p1Name = p1Bye ? 'BYE' : (champion && p1Winner ? `🏆 ${match.p1BotName}` : match.p1BotName);
    const p2Name = p2Bye ? 'BYE' : (champion && p2Winner ? `🏆 ${match.p2BotName}` : match.p2BotName);

    put(rows, cardRow, columnIndex, p1Name || 'BYE', maxColumn);
    put(rows, cardRow, columnIndex + 1, bracketScore(match, match.p1BotId, p1Bye), maxColumn);
    put(rows, cardRow + 1, columnIndex, p2Name || 'BYE', maxColumn);
    put(rows, cardRow + 1, columnIndex + 1, bracketScore(match, match.p2BotId, p2Bye), maxColumn);
    put(rows, cardRow + 2, columnIndex, matchStatusLabel(match), maxColumn);
    merges.push(cellRange(cardRow + 2, cardRow + 3, columnIndex, columnIndex + 2));

    const cardRange = cellRange(cardRow, cardRow + CARD_ROWS, columnIndex, columnIndex + 2);
    styles.push(style(cardRange, {
      background: champion ? COLORS.gold : COLORS.white,
      textFormat: textFormat({ fontSize: 10, foregroundColor: COLORS.ink }),
      verticalAlignment: 'MIDDLE'
    }));
    styles.push(style(cellRange(cardRow + 2, cardRow + 3, columnIndex, columnIndex + 2), {
      textFormat: textFormat({ fontSize: 9, foregroundColor: COLORS.muted }),
      horizontalAlignment: 'LEFT',
      verticalAlignment: 'MIDDLE'
    }));
    if (p1Winner) {
      styles.push(style(cellRange(cardRow, cardRow + 1, columnIndex, columnIndex + 1), {
        textFormat: textFormat({ bold: true, foregroundColor: COLORS.green })
      }));
    }
    if (p2Winner) {
      styles.push(style(cellRange(cardRow + 1, cardRow + 2, columnIndex, columnIndex + 1), {
        textFormat: textFormat({ bold: true, foregroundColor: COLORS.green })
      }));
    }
    styles.push(style(cellRange(cardRow, cardRow + CARD_ROWS, columnIndex + 1, columnIndex + 2), {
      textFormat: textFormat({ bold: true }),
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE'
    }));
    borders.push(border(cardRange, champion ? COLORS.green : COLORS.border, champion ? 2 : 1));

    if (roundIndex > 0) {
      const gapColumn = columnIndex - 1;
      put(rows, cardRow + 1, gapColumn, '→', maxColumn);
      styles.push(style(cellRange(cardRow + 1, cardRow + 2, gapColumn, gapColumn + 1), {
        textFormat: textFormat({ foregroundColor: COLORS.muted }),
        horizontalAlignment: 'CENTER'
      }));
    }
    return { layouts, roundIndex, stage };
  }

  winnerLayouts.forEach((positions, roundIndex) => {
    positions.forEach(position => {
      placeCard(position, winnersTop, roundIndex * COLUMNS_PER_ROUND, winnerLayouts, roundIndex, 'winners');
    });
  });
  loserLayouts.forEach((positions, roundIndex) => {
    positions.forEach(position => {
      placeCard(position, losersTop, roundIndex * COLUMNS_PER_ROUND, loserLayouts, roundIndex, 'losers');
    });
  });

  if (grandFinalMatch) {
    placeHeader(Math.max(0, grandFinalRow - 1), grandFinalColumn, 'Chung kết tổng');
    placeCard(
      { match: grandFinalMatch, row: grandFinalRow - winnersTop, feeds: [] },
      winnersTop,
      grandFinalColumn,
      [],
      0,
      'grand-final'
    );
    const gapColumn = grandFinalColumn - 1;
    put(rows, grandFinalRow + 1, gapColumn, '→', maxColumn);
    styles.push(style(cellRange(grandFinalRow + 1, grandFinalRow + 2, gapColumn, gapColumn + 1), {
      textFormat: textFormat({ foregroundColor: COLORS.muted }),
      horizontalAlignment: 'CENTER'
    }));
  }

  const width = maxColumn;
  const maxRow = rows.length;
  const widths = [];
  for (let roundIndex = 0; roundIndex < maxRounds; roundIndex++) {
    const column = roundIndex * COLUMNS_PER_ROUND;
    widths.push(
      { startIndex: column, endIndex: column + 1, pixelSize: 190 },
      { startIndex: column + 1, endIndex: column + 2, pixelSize: 46 },
      { startIndex: column + 2, endIndex: column + 3, pixelSize: 28 }
    );
  }
  if (grandFinalMatch) {
    widths.push(
      { startIndex: grandFinalColumn, endIndex: grandFinalColumn + 1, pixelSize: 190 },
      { startIndex: grandFinalColumn + 1, endIndex: grandFinalColumn + 2, pixelSize: 46 }
    );
  }

  return {
    title: 'Playoff',
    rows,
    merges,
    styles,
    borders,
    widths,
    rowHeights: [{ startIndex: 0, endIndex: maxRow, pixelSize: 24 }],
    frozenRows: 1,
    columnCount: width
  };
}

function buildTournamentSheets(tournament) {
  const specs = [buildOverviewTab(tournament)];
  if (tournament.format === 'round-robin-two-legs') {
    specs.push(buildRoundRobinTab(tournament));
  } else {
    for (const round of swissRounds(tournament)) {
      const matches = (tournament.matches || []).filter(match =>
        (match.stage || 'swiss') === 'swiss' && match.round === round);
      specs.push(buildRoundTab(tournament, round, matches));
    }
  }
  specs.push(buildPlayoffTab(tournament));
  return specs.map((spec, index) => ({ ...spec, index }));
}

module.exports = {
  buildTournamentSheets,
  buildOverviewTab,
  buildRoundTab,
  buildPlayoffTab,
  bracketRounds,
  bracketLayoutRows,
  upperRoundLabel,
  lowerRoundLabel,
  formatLabel,
  matchScore,
  matchStatusLabel
};
