#include "arena/api.hpp"

class ExamplePlayer final : public arena::Player {
  public:
    void on_match_start(const arena::MatchStart &start) override {
        side_ = start.side;
    }

    arena::Action act(const arena::Observation &observation) override {
        if (observation.round == 1) {
            return arena::Action::move(side_ == arena::Side::Red ? arena::Direction::South
                                                                  : arena::Direction::North);
        }
        if (observation.round == 2) {
            return arena::Action::move(side_ == arena::Side::Red ? arena::Direction::East
                                                                  : arena::Direction::West);
        }
        if (observation.round == 3 && observation.action_index == 1) {
            return arena::Action::turn(side_ == arena::Side::Red ? arena::Direction::East
                                                                  : arena::Direction::West);
        }
        if (observation.round == 3 && observation.action_index == 2) {
            return arena::Action::fire();
        }
        return arena::Action::scout();
    }

  private:
    arena::Side side_ = arena::Side::Red;
};

extern "C" arena::Player *create_player() {
    return new ExamplePlayer();
}
