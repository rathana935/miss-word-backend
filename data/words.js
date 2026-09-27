export const WORDS = [
  "APPLE",
  "ORANGE",
  "BANANA",
  "GRAPE",
  "MANGO",
  "PAPAYA",
  "WATERMELON",
  "PINEAPPLE",
  "STRAWBERRY",
  "BLUEBERRY",

  "TIGER",
  "LION",
  "ELEPHANT",
  "MONKEY",
  "RABBIT",
  "HORSE",
  "ZEBRA",
  "GIRAFFE",
  "PANDA",
  "KANGAROO",

  "SCHOOL",
  "TEACHER",
  "STUDENT",
  "BOOK",
  "PENCIL",
  "CLASSROOM",
  "LESSON",
  "HOMEWORK",
  "LIBRARY",
  "EXAM",

  "COMPUTER",
  "KEYBOARD",
  "MONITOR",
  "MOUSE",
  "PHONE",
  "CAMERA",
  "INTERNET",
  "WEBSITE",
  "SERVER",
  "DATABASE",

  "HOUSE",
  "WINDOW",
  "DOOR",
  "KITCHEN",
  "BEDROOM",
  "GARDEN",
  "TABLE",
  "CHAIR",
  "FAMILY",
  "FRIEND",

  "MORNING",
  "EVENING",
  "NIGHT",
  "SUMMER",
  "WINTER",
  "SPRING",
  "AUTUMN",
  "MONDAY",
  "FRIDAY",
  "SUNDAY",

  "COUNTRY",
  "CITY",
  "VILLAGE",
  "RIVER",
  "MOUNTAIN",
  "FOREST",
  "OCEAN",
  "ISLAND",
  "BRIDGE",
  "ROAD",

  "HAPPY",
  "BEAUTIFUL",
  "STRONG",
  "BRIGHT",
  "SIMPLE",
  "FAMOUS",
  "IMPORTANT",
  "SPECIAL",
  "FRIENDLY",
  "HONEST",

  "CHICKEN",
  "BEEF",
  "FISH",
  "RICE",
  "BREAD",
  "CHEESE",
  "MILK",
  "COFFEE",
  "WATER",
  "SUGAR",

  "MOBILE",
  "GAMING",
  "PLAYER",
  "LEVEL",
  "POINT",
  "REWARD",
  "WINNER",
  "PUZZLE",
  "ANSWER",
  "QUESTION"
];

export function getWordForLevel(mode, level) {
  const modeOffset = {
    easy: 0,
    medium: 100,
    hard: 200,
    difficult: 300
  };

  const offset = modeOffset[mode] || 0;

  const index =
    (offset + Number(level) - 1) % WORDS.length;

  return WORDS[index];
}
