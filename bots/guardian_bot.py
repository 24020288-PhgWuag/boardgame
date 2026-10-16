"""Cautious, goal-oriented bot for the OTT V2 JSON Lines protocol."""

import json
import random
import sys


BOARD_SIZE = 9
TYPES = ("rock", "paper", "scissors")
BEATS = {
    "rock": "scissors",
    "scissors": "paper",
    "paper": "rock",
}


def opponent(player):
    return "p2" if player == "p1" else "p1"


def legal_moves(board, player):
    moves = []
    for row, cells in enumerate(board):
        for col, piece in enumerate(cells):
            if not piece or piece["player"] != player:
                continue

            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if dr == 0 and dc == 0:
                        continue
                    nr, nc = row + dr, col + dc
                    if not (0 <= nr < len(board) and 0 <= nc < len(board[nr])):
                        continue

                    target = board[nr][nc]
                    if target and target["player"] == player:
                        continue
                    if target and target["type"] == piece["type"]:
                        continue
                    moves.append(((row, col), (nr, nc)))
    return moves


def simulate_move(board, player, move):
    (fr, fc), (tr, tc) = move
    result = [row[:] for row in board]
    attacker = result[fr][fc]
    defender = result[tr][tc]

    if defender and BEATS[attacker["type"]] != defender["type"]:
        result[fr][fc] = None
    else:
        result[tr][tc] = attacker
        result[fr][fc] = None
    return result


def move_result(board, player, move):
    (fr, fc), (tr, tc) = move
    attacker = board[fr][fc]
    defender = board[tr][tc]
    if defender and BEATS[attacker["type"]] != defender["type"]:
        return "defeat"
    return "capture" if defender else "move"


def all_winning_moves(board, player):
    winning = []
    for move in legal_moves(board, player):
        next_board = simulate_move(board, player, move)
        if move_winner(next_board, player, move[1]) == player:
            winning.append(move)
    return winning


def threatened_moves(board, player):
    """Return opponent moves that would win immediately in the current position."""
    return all_winning_moves(board, opponent(player))


def is_last_piece_type(board, player, move):
    (fr, fc), _ = move
    piece = board[fr][fc]
    if not piece:
        return False
    return piece_counts(board, player)[piece["type"]] == 1


def leaves_immediate_loss(board, player, move):
    next_board = simulate_move(board, player, move)
    return bool(threatened_moves(next_board, player))


def attack_risk(board, player, move):
    """Count strong opponent captures after this move."""
    next_board = simulate_move(board, player, move)
    enemy = opponent(player)
    risk = 0
    for enemy_move in legal_moves(next_board, enemy):
        (fr, fc), (tr, tc) = enemy_move
        target = next_board[tr][tc]
        attacker = next_board[fr][fc]
        if target and BEATS[attacker["type"]] == target["type"]:
            risk += 1
            if piece_counts(next_board, player)[target["type"]] == 1:
                risk += 4
    return risk


def piece_counts(board, player):
    counts = {piece_type: 0 for piece_type in TYPES}
    for row in board:
        for piece in row:
            if piece and piece["player"] == player:
                counts[piece["type"]] += 1
    return counts


def move_winner(board, player, destination):
    row, col = destination
    if (player == "p1" and (row, col) == (8, 8)) or (
        player == "p2" and (row, col) == (0, 0)
    ):
        return player

    own = piece_counts(board, player)
    other = piece_counts(board, opponent(player))
    own_wiped = any(own[kind] == 0 for kind in TYPES)
    other_wiped = any(other[kind] == 0 for kind in TYPES)
    if other_wiped and not own_wiped:
        return player
    if own_wiped and not other_wiped:
        return opponent(player)
    if own_wiped and other_wiped:
        return player
    return None


def goal_distance(player, row, col):
    goal = (8, 8) if player == "p1" else (0, 0)
    return max(abs(goal[0] - row), abs(goal[1] - col))


def evaluate(board, player):
    enemy = opponent(player)
    own_counts = piece_counts(board, player)
    enemy_counts = piece_counts(board, enemy)
    score = 0.0

    # Preserve every piece type: losing the last one can decide the game.
    for kind in TYPES:
        score += own_counts[kind] * 100
        score -= enemy_counts[kind] * 100
        if own_counts[kind] == 1:
            score -= 45
        if enemy_counts[kind] == 1:
            score += 45

    for row, cells in enumerate(board):
        for col, piece in enumerate(cells):
            if not piece:
                continue
            side = piece["player"]
            sign = 1 if side == player else -1

            # Prefer advancing toward the opposing corner, while keeping the
            # score modest so a risky sprint does not outweigh a safe capture.
            distance = goal_distance(side, row, col)
            score += sign * (16 - distance) * 2.0

            # Penalize pieces an adjacent enemy can capture on its next turn.
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if dr == 0 and dc == 0:
                        continue
                    nr, nc = row + dr, col + dc
                    if not (0 <= nr < len(board) and 0 <= nc < len(board[nr])):
                        continue
                    nearby = board[nr][nc]
                    if not nearby or nearby["player"] == side:
                        continue
                    if BEATS[nearby["type"]] == piece["type"]:
                        score -= sign * 34

    return score


def tactical_score(board, player, move):
    """Score a move using the rules' actual win and loss conditions."""
    enemy = opponent(player)
    next_board = simulate_move(board, player, move)
    result = move_result(board, player, move)
    winner = move_winner(next_board, player, move[1])
    score = evaluate(next_board, player)

    if winner == player:
        return 1_000_000
    if winner == enemy:
        return -1_000_000

    if result == "capture":
        score += 1_500
        if board[move[1][0]][move[1][1]]["type"] in TYPES:
            score += 250

    # Never sacrifice the only piece of a type unless it wins immediately.
    if is_last_piece_type(board, player, move):
        score -= 3_000

    # Prefer positions that preserve all three types.
    own_counts = piece_counts(next_board, player)
    enemy_counts = piece_counts(next_board, enemy)
    score += sum(800 for kind in TYPES if own_counts[kind] > 0)
    score += sum(700 for kind in TYPES if enemy_counts[kind] == 0)

    # Winning next turn is good, but allowing the opponent to win next turn
    # is usually fatal and must outweigh material gains.
    score += len(all_winning_moves(next_board, player)) * 8_000
    score -= len(threatened_moves(next_board, player)) * 120_000
    score -= attack_risk(board, player, move) * 450

    (fr, fc), (tr, tc) = move
    target = board[tr][tc]
    if target and target["player"] == enemy and BEATS[board[fr][fc]["type"]] == target["type"]:
        score += 900

    # A direct block is valuable when the opponent currently has a winning move.
    enemy_wins_now = threatened_moves(board, player)
    if enemy_wins_now and not threatened_moves(next_board, player):
        score += 100_000

    score += random.random() * 0.01
    return score


def choose_move(message):
    player = message["player"]
    board = message["state"]["board"]
    moves = legal_moves(board, player)
    if not moves:
        return {
            "type": "error",
            "code": "NO_MOVE",
            "message": "No legal move found.",
        }

    winning_moves = all_winning_moves(board, player)
    if winning_moves:
        best_move = random.choice(winning_moves)
    else:
        enemy_wins = threatened_moves(board, player)
        scored_moves = [(tactical_score(board, player, move), move) for move in moves]
        safe_moves = [item for item in scored_moves if not leaves_immediate_loss(board, player, item[1])]

        # If the opponent has a winning move, only consider moves that remove it.
        if enemy_wins and safe_moves:
            scored_moves = safe_moves
        elif safe_moves:
            scored_moves = safe_moves

        best_score = max(score for score, _ in scored_moves)
        best_moves = [move for score, move in scored_moves if score >= best_score - 0.01]
        best_move = random.choice(best_moves)

    (fr, fc), (tr, tc) = best_move
    return {
        "protocol_version": 1,
        "type": "action",
        "action": {
            "type": "move",
            "from": {"row": fr, "col": fc},
            "to": {"row": tr, "col": tc},
        },
    }


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            response = choose_move(json.loads(line))
        except (KeyError, TypeError, ValueError) as error:
            response = {
                "type": "error",
                "code": "INVALID_REQUEST",
                "message": str(error),
            }
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
