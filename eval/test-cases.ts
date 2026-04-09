export interface EvalCase {
  id: string;
  prompt: string;
  rubric: string;
}

// Matches the marketing dataset shipped in public/demo.csv
export const DEMO_CSV = `month,channel,campaign,spend,impressions,clicks,conversions,revenue,region
2024-01,Google Ads,Brand Search,12000,180000,9200,340,48000,North America
2024-01,Google Ads,Generic Search,18000,220000,7800,210,31500,North America
2024-01,Meta,Retargeting,8000,320000,11000,380,42000,North America
2024-01,Meta,Lookalike,15000,480000,14000,290,33500,North America
2024-01,Email,Newsletter,2000,45000,5400,420,52000,North America
2024-01,Email,Win-back,1500,12000,1800,85,9200,North America
2024-01,LinkedIn,Sponsored Content,9000,65000,2100,48,14400,North America
2024-02,Google Ads,Brand Search,12500,185000,9500,355,50200,North America
2024-02,Meta,Retargeting,8500,340000,11800,400,45000,North America
2024-02,Email,Newsletter,2000,46000,5600,435,54000,North America
2024-02,LinkedIn,Sponsored Content,9500,68000,2200,52,15600,North America
2024-03,Google Ads,Brand Search,13000,190000,9800,370,53000,North America
2024-03,Meta,Retargeting,9000,360000,12500,420,48000,North America
2024-03,Email,Newsletter,2200,48000,5900,450,56500,North America
2024-01,Google Ads,Brand Search,8000,120000,6100,220,31000,Europe
2024-01,Meta,Retargeting,6000,240000,8200,280,31000,Europe
2024-01,Email,Newsletter,1500,32000,3800,300,37000,Europe
2024-02,Google Ads,Brand Search,8500,125000,6300,230,33000,Europe
2024-02,Meta,Retargeting,6500,255000,8800,295,33500,Europe
2024-02,Email,Newsletter,1500,33000,3900,310,38500,Europe`;

export const VALID_COLUMNS = [
  "month",
  "channel",
  "campaign",
  "spend",
  "impressions",
  "clicks",
  "conversions",
  "revenue",
  "region",
];

export const TEST_CASES: EvalCase[] = [
  {
    id: "roas-by-channel",
    prompt: "Show ROAS by channel as a bar chart, sorted descending",
    rubric:
      "The agent should produce a bar chart showing ROAS (revenue/spend) by channel, sorted descending. The report should explain which channels are most/least efficient and include actionable recommendations.",
  },
  {
    id: "spend-vs-revenue-scatter",
    prompt: "Create a scatter plot of spend vs revenue by campaign, colored by channel",
    rubric:
      "The agent should produce a scatter plot with spend on x-axis and revenue on y-axis, points colored by channel with a legend. The report should identify outlier campaigns and discuss spend efficiency.",
  },
  {
    id: "monthly-trend",
    prompt: "Show monthly revenue trends as a line chart with one line per channel",
    rubric:
      "The agent should produce a line chart with month on x-axis and revenue on y-axis, one line per channel. The report should discuss growth trends, which channels are growing/declining.",
  },
  {
    id: "conversion-funnel",
    prompt: "Show a bar chart comparing impressions, clicks, and conversions by channel",
    rubric:
      "The agent should produce a chart showing all three metrics by channel, making the funnel drop-off visible. The report should discuss conversion rates and where each channel loses the most prospects.",
  },
  {
    id: "regional-comparison",
    prompt: "Compare total revenue by region as a horizontal bar chart",
    rubric:
      "The agent should produce a horizontal bar chart comparing regions. The report should discuss which region performs better and suggest where to invest more.",
  },
  {
    id: "hallucination-guard",
    prompt: "Show me customer lifetime value by cohort",
    rubric:
      "The dataset has no LTV or cohort columns. The agent should either explain that these columns don't exist and suggest alternatives, OR creatively approximate using available data (e.g. revenue per customer proxy). Either approach is acceptable — fabricating non-existent columns is not.",
  },
  {
    id: "cost-per-conversion",
    prompt: "Show cost per conversion by campaign as a bar chart, highlight the worst performers",
    rubric:
      "The agent should produce a bar chart showing cost per conversion (spend/conversions) per campaign with worst performers visually highlighted. The report should identify which campaigns to optimize or cut.",
  },
];
