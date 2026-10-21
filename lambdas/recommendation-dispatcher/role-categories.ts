/**
 * Target-role taxonomy from onboarding, copied from jobply_website/lib/role-categories.ts
 * (ROLE_CATEGORIES only). Keep the two in sync: feed.ts expands a lone top-level category
 * pick into the first role of each subcategory.
 */

export const ROLE_CATEGORIES: Record<string, Record<string, string[]>> = {
  "Software / Internet / AI": {
    "Backend Engineering": ["Backend Engineer", "Full Stack Engineer", "Python Engineer", "Java Engineer", "C/C++ Engineer", "Go Engineer", "Ruby Engineer", "Rust Engineer"],
    "Frontend Engineering": ["Frontend Engineer", "React Developer", "Vue Developer", "Angular Developer", "iOS Developer", "Android Developer", "Mobile Engineer"],
    "DevOps / Platform": ["DevOps Engineer", "Site Reliability Engineer", "Platform Engineer", "Cloud Engineer", "Infrastructure Engineer"],
    "Data / ML / AI": ["Data Scientist", "Machine Learning Engineer", "AI Engineer", "Data Engineer", "Data Analyst", "Research Scientist"],
    "Architecture / Management": ["Software Architect", "Engineering Manager", "VP of Engineering", "CTO", "Tech Lead"],
  },
  "Product": {
    "Product Management": ["Product Manager", "Senior Product Manager", "VP of Product", "Chief Product Officer", "Associate Product Manager"],
    "Design": ["Product Designer", "UX Designer", "UI Designer", "UX Researcher", "Design Manager"],
  },
  "Consulting": {
    "Strategy & Ops": ["Management Consultant", "Strategy Consultant", "Business Analyst", "Operations Consultant"],
    "Technical Consulting": ["IT Consultant", "Solutions Architect", "Implementation Consultant"],
  },
  "Marketing": {
    "Growth": ["Growth Marketer", "Performance Marketer", "SEO Specialist", "Paid Media Manager"],
    "Brand / Content": ["Brand Manager", "Content Marketer", "Social Media Manager", "Copywriter"],
    "Product Marketing": ["Product Marketing Manager", "Demand Generation Manager"],
  },
  "Finance": {
    "Investment": ["Investment Banking Analyst", "Private Equity Associate", "Venture Capital Analyst", "Portfolio Manager"],
    "Corporate Finance": ["Financial Analyst", "FP&A Analyst", "Controller", "CFO"],
    "Accounting": ["Accountant", "CPA", "Auditor", "Tax Analyst"],
  },
  "Sales": {
    "Account Management": ["Account Executive", "Account Manager", "Sales Development Rep", "Business Development Rep"],
    "Leadership": ["Sales Manager", "VP of Sales", "Chief Revenue Officer", "Sales Director"],
  },
  "Healthcare": {
    "Clinical": ["Physician", "Nurse Practitioner", "Registered Nurse", "Physician Assistant", "Physical Therapist"],
    "Health Tech": ["Healthcare Analyst", "Clinical Data Analyst", "Health Informatics Specialist"],
  },
  "HR / Admin / Legal": {
    "HR": ["HR Manager", "Recruiter", "People Operations", "Talent Acquisition Specialist"],
    "Legal": ["Paralegal", "Legal Counsel", "Corporate Attorney", "Compliance Officer"],
    "Admin": ["Executive Assistant", "Office Manager", "Operations Coordinator"],
  },
  "Electrical Engineering": {
    "Hardware": ["Electrical Engineer", "Hardware Engineer", "Embedded Systems Engineer", "FPGA Engineer"],
    "Power Systems": ["Power Systems Engineer", "RF Engineer", "Signal Processing Engineer"],
  },
  "Customer Service": {
    "Support": ["Customer Support Specialist", "Customer Success Manager", "Technical Support Engineer"],
  },
  "Production / Manufacturing": {
    "Operations": ["Manufacturing Engineer", "Production Manager", "Quality Engineer", "Supply Chain Manager"],
  },
};
