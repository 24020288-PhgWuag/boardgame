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

    best_move = None
    best_score = float("-inf")
    for move in moves:
        next_board = simulate_move(board, player, move)
        winner = move_winner(next_board, player, move[1])
        if winner == player:
            score = 1_000_000
        elif winner == opponent(player):
            score = -1_000_000
        else:
            score = evaluate(next_board, player)
            (fr, fc), (tr, tc) = move
            target = board[tr][tc]
            attacker = board[fr][fc]
            if target and BEATS[attacker["type"]] == target["type"]:
                score += 35
            # Break ties so the bot does not repeat the same move forever.
            score += random.random() * 0.5

        if score > best_score:
            best_score = score
            best_move = move

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
