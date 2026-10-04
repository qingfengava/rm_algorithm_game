#include "arena/api.hpp"

class BaselinePlayer final : public arena::Player {
  public:
    void on_match_start(const arena::MatchStart &start) override {
        side_ = start.side;
    }

    arena::Action act(const arena::Observation &observation) override {
        if (observation.action_index == 1) {
            return arena::Action::scout();
        }
        if (observation.action_index == 2) {
            return arena::Action::turn(arena::Direction::North);
        }

        switch (observation.round % 3) {
        case 1:
            return arena::Action::elevate();
        case 2:
            return arena::Action::move(side_ == arena::Side::Red ? arena::Direction::West
                                                                   : arena::Direction::East);
        default:
            return arena::Action::fire();
        }
    }

  private:
    arena::Side side_ = arena::Side::Red;
};

extern "C" arena::Player *create_player() {
    return new BaselinePlayer();
}
